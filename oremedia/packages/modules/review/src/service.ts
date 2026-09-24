import type { z } from 'zod';
import { ApprovalBindingV1 } from '@oremedia/contracts/approval';
import { ExternalLinkCreate, ExternalLinkRevoke } from '@oremedia/contracts/access';
import { ConflictError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { MandateCreate } from '@oremedia/contracts/publishing';
import {
  ApprovalGet,
  FrozenManifestV1,
  MandateGet,
  MandatePause,
  MandateRevoke,
  ReviewDecisionSubmit,
  ReviewInboxList,
  ReviewRequestCreate,
  ReviewRequestGet,
  type ApprovalInvalidatedReason,
  type InboxAttention,
  type StaleReason,
} from '@oremedia/contracts/review';
import { requireTenant, type Tx } from '@oremedia/db';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { approvalMachine } from '@oremedia/domain/state-machines/approval';
import { IllegalTransitionError, type StateMachine } from '@oremedia/domain/state-machines/machine';
import { mandateMachine } from '@oremedia/domain/state-machines/mandate';
import { reviewRequestMachine } from '@oremedia/domain/state-machines/review-request';
import {
  ExternalReviewerLinkRepository,
  MembershipRepository,
  ServicePrincipalRepository,
  accessService,
  policy,
} from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { contentService, hashesForVariant, type RevisionChange } from '@oremedia/module-content';
import { audit, featureFlag, outbox } from '@oremedia/module-operations';
import {
  bindingForRevision,
  buildLiveBinding,
  decisionPolicyOptions,
  evaluateRelease,
  hasNoBlockingFindings,
  type ApprovalRow,
  type MandateRow,
  factRevocationScope,
} from './evaluate-release';
import {
  PublishingMandateRepository,
  ReleaseApprovalRepository,
  ReviewDecisionRepository,
  ReviewRequestRepository,
} from './repositories';

const requestsRepo = new ReviewRequestRepository();
const decisionsRepo = new ReviewDecisionRepository();
const approvalsRepo = new ReleaseApprovalRepository();
const mandatesRepo = new PublishingMandateRepository();
// Reviewer links are access rows (spec 6.3); read through the access module's public index.
const linksRepo = new ExternalReviewerLinkRepository();
const membershipsRepo = new MembershipRepository();
const principalsRepo = new ServicePrincipalRepository();

type RequestRow = Awaited<ReturnType<typeof requestsRepo.getById>>;
type DecisionRow = Awaited<ReturnType<typeof decisionsRepo.getById>>;

/** Hashed request origin the API context carries for decisions (spec 5.6: IP and user-agent hash, never raw). */
/**
 * Policy options the caller may pass through (spec 5.5 step 7): the agent runtime supplies the run's autonomy mode;
 * the router passes nothing, so an agent requesting review through the API is held to `assist` and denied.
 */
export interface ActorOptions {
  autonomyMode?: AutonomyMode;
}

export interface DecisionMeta {
  ipHash?: string | null;
  userAgentHash?: string | null;
}

// ---- helpers ----

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const requestResource = (r: RequestRow, extra: { state?: string; authorPrincipalId?: string } = {}) => ({
  type: 'review_request',
  tenantId: r.tenantId,
  brandId: r.brandId,
  id: r.id,
  reviewRequestId: r.id,
  ...extra,
});

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
function transition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
  path: string,
): S {
  try {
    return machine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

const deciderKindOf = (actor: ResolvedActor): 'user' | 'external_reviewer' => {
  if (actor.kind === 'user') return 'user';
  if (actor.kind === 'external_reviewer') return 'external_reviewer';
  throw new PolicyDeniedError('agent_never', 'Only a person can decide a review');
};

/**
 * Spec 5.6: the magic link *is* the email verification: the first authenticated use verifies the address it was
 * sent to, and every use is recorded. Bookkeeping only, so a concurrent touch is ignored rather than failed.
 */
async function touchLink(actor: ResolvedActor, tx: Tx) {
  if (actor.kind !== 'external_reviewer') return null;
  const link = await linksRepo.getById(actor.id, tx);
  const now = new Date();
  try {
    await linksRepo.update(
      link.id,
      link.version,
      { lastUsedAt: now, emailVerifiedAt: link.emailVerifiedAt ?? now },
      tx,
    );
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
  }
  return link;
}

async function markStale(request: RequestRow, reason: StaleReason, tx: Tx) {
  const toState = transition(reviewRequestMachine, request.state, 'package_changed', 'reviewRequestId');
  await requestsRepo.update(request.id, request.version, { state: toState, staleReason: reason }, tx);
  await outbox.add(
    'review.request_stale',
    { type: 'review_request', id: request.id, version: request.version + 1 },
    { reviewRequestId: request.id, contentRevisionId: request.contentRevisionId, reason },
    tx,
    { brandId: request.brandId },
  );
  await audit.record(
    requireTenant().actor,
    'review.request.stale',
    { type: 'review_request', id: request.id },
    'allowed',
    tx,
    {
      brandId: request.brandId,
      revisionId: request.contentRevisionId,
      fromState: request.state,
      toState,
      reason,
    },
  );
}

async function invalidate(apr: ApprovalRow, reason: ApprovalInvalidatedReason, tx: Tx) {
  const toState = transition(approvalMachine, apr.state, 'invalidate', 'approvalId');
  await approvalsRepo.setState(apr.id, apr.version, toState, reason, tx);
  await outbox.add(
    'approval.invalidated',
    { type: 'release_approval', id: apr.id, version: apr.version + 1 },
    { approvalId: apr.id, contentRevisionId: apr.contentRevisionId, reason },
    tx,
    { brandId: apr.brandId },
  );
  await audit.record(
    requireTenant().actor,
    'review.approval.invalidate',
    { type: 'release_approval', id: apr.id },
    'allowed',
    tx,
    { brandId: apr.brandId, revisionId: apr.contentRevisionId, fromState: apr.state, toState, reason },
  );
}

// ---- DTO mappers: JSON documents are validated on read as well as on write (spec 6.1) ----

const toRequestDto = (r: RequestRow) => ({
  id: r.id,
  brandId: r.brandId,
  contentRevisionId: r.contentRevisionId,
  frozenManifest: FrozenManifestV1.parse(r.frozenManifest),
  manifestHash: r.manifestHash,
  assignees: r.assignees,
  dueAt: r.dueAt ? r.dueAt.toISOString() : null,
  state: r.state,
  staleReason: r.staleReason,
  requestedByKind: r.requestedByKind,
  requestedById: r.requestedById,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  version: r.version,
});
/** Spec 5.6: an external reviewer sees exactly the frozen manifest of their request and why it may be stale. */
const toReviewerView = (r: RequestRow) => ({
  id: r.id,
  state: r.state,
  staleReason: r.staleReason,
  frozenManifest: FrozenManifestV1.parse(r.frozenManifest),
  manifestHash: r.manifestHash,
  dueAt: r.dueAt ? r.dueAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
});
const toDecisionDto = (d: DecisionRow) => ({
  id: d.id,
  reviewRequestId: d.reviewRequestId,
  deciderKind: d.deciderKind,
  deciderId: d.deciderId,
  decision: d.decision,
  comment: d.comment,
  manifestHash: d.manifestHash,
  verifiedEmail: d.verifiedEmail,
  createdAt: d.createdAt.toISOString(),
});
const toApprovalDto = (a: ApprovalRow) => ({
  id: a.id,
  brandId: a.brandId,
  contentRevisionId: a.contentRevisionId,
  reviewRequestId: a.reviewRequestId,
  approverKind: a.approverKind,
  approverId: a.approverId,
  bindingHash: a.bindingHash,
  binding: ApprovalBindingV1.parse(a.binding),
  validUntil: a.validUntil ? a.validUntil.toISOString() : null,
  state: a.state,
  invalidatedReason: a.invalidatedReason,
  createdAt: a.createdAt.toISOString(),
  version: a.version,
});
const toMandateDto = (m: MandateRow) => ({
  id: m.id,
  brandId: m.brandId,
  ownerUserId: m.ownerUserId,
  servicePrincipalId: m.servicePrincipalId,
  channelConnectionIds: m.channelConnectionIds,
  allowedContentClasses: m.allowedContentClasses,
  sourceRules: m.sourceRules,
  maxPostsPerDay: m.maxPostsPerDay,
  windowStart: m.windowStart.toISOString(),
  windowEnd: m.windowEnd.toISOString(),
  state: m.state,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
  version: m.version,
});

/** Spec 13.3: exactly what the reviewer sees, computed the same way the binding is (hashesForVariant). */
async function freezeManifest(
  revision: Awaited<ReturnType<typeof contentService.revisions.read>>,
  timing: FrozenManifestV1['timing'],
  tx: Tx,
): Promise<FrozenManifestV1> {
  const variants = await contentService.variants.listForRevision(revision.id, tx);
  if (variants.length === 0)
    throw new ValidationFailedError(
      [{ path: 'contentRevisionId', issue: 'no_channel_variants' }],
      'Generate at least one channel variant before requesting review',
    );
  return FrozenManifestV1.parse({
    v: 1,
    contentRevisionId: revision.id,
    contentHash: revision.contentHash,
    creativeRevisionIds: revision.creativeRevisionIds,
    exports: variants.flatMap((v) =>
      v.exportIds.map((exportId, i) => ({
        exportId,
        contentHash: v.exportHashes[i] as string,
        channelConnectionId: v.channelConnectionId,
      })),
    ),
    captions: variants.map((v) => ({
      channelConnectionId: v.channelConnectionId,
      text: v.text,
      altTexts: v.altTexts,
      settingsHash: hashesForVariant(v).settingsHash,
    })),
    timing,
    brandVersionId: revision.brandVersionId,
    policyVersionId: revision.policyVersionId,
  });
}

/** Spec 21.2: what an inbox item needs from the reader. */
function attentionFor(
  request: RequestRow,
  revisionState: string,
  approvals: ApprovalRow[],
  revokedLinks: number,
): InboxAttention[] {
  const out: InboxAttention[] = [];
  if (request.state === 'open') out.push('awaiting_decision');
  if (request.state === 'stale') out.push('stale');
  if (request.state === 'decided' && revisionState === 'changes_requested') out.push('changes_requested');
  if (approvals.some((a) => a.state === 'valid')) out.push('approved');
  if (approvals.some((a) => a.state === 'invalidated')) out.push('approval_invalidated');
  if (revokedLinks > 0) out.push('external_access_revoked');
  return out;
}

export const reviewService = {
  requests: {
    /**
     * Spec 13.3: freezes the manifest (revision ids, export ids and hashes, captions, channel targets, timing) and
     * its hash, moves the revision draft | changes_requested → in_review, and tells the world. One open request
     * per revision. The revision must be written against the brand's current published version.
     */
    async create(
      actor: ResolvedActor,
      input: z.input<typeof ReviewRequestCreate>,
      tx: Tx,
      opts: ActorOptions = {},
    ) {
      const parsed = ReviewRequestCreate.parse(input);
      const revision = await contentService.revisions.get(
        actor,
        { revisionId: parsed.contentRevisionId },
        tx,
      );
      await policy.assert(
        actor,
        'review.request',
        {
          type: 'content_revision',
          tenantId: revision.tenantId,
          brandId: revision.brandId,
          id: revision.id,
          state: revision.state,
        },
        opts,
        tx,
      );
      // Assignees are active members of this company; a foreign or unknown user id reads the same (no enumeration).
      for (const [i, userId] of parsed.assigneeUserIds.entries()) {
        const membership = await membershipsRepo.findByUser(userId, tx);
        if (membership?.status !== 'active')
          throw new ValidationFailedError([{ path: `assigneeUserIds.${i}`, issue: 'assignee_not_found' }]);
      }
      if ((await requestsRepo.listOpenForRevision(revision.brandId, revision.id, tx)).length)
        throw new ValidationFailedError([{ path: 'contentRevisionId', issue: 'request_already_open' }]);
      const brand = await brandService.get(actor, revision.brandId, tx);
      if (
        brand.publishedVersionId !== revision.brandVersionId ||
        brand.activePolicyVersionId !== revision.policyVersionId
      )
        throw new ValidationFailedError(
          [{ path: 'contentRevisionId', issue: 'brand_version_outdated' }],
          'The brand changed since this revision was written; revise the package first',
        );
      const manifest = await freezeManifest(revision, parsed.timing, tx);
      const manifestHash = hashCanonical(manifest);
      const moved = await contentService.revisions.transition(revision.id, 'request_review', tx);
      const id = newId('reviewRequest');
      await requestsRepo.create(
        {
          id,
          brandId: revision.brandId,
          contentRevisionId: revision.id,
          frozenManifest: manifest,
          manifestHash,
          assignees: parsed.assigneeUserIds,
          dueAt: parsed.dueAt ? new Date(parsed.dueAt) : null,
          state: 'open',
          staleReason: null,
          requestedByKind: actor.kind === 'service_principal' ? 'agent' : 'user',
          requestedById: actor.id,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'review.request.create',
        { type: 'review_request', id },
        'allowed',
        tx,
        { brandId: revision.brandId, revisionId: revision.id, toState: moved.toState },
      );
      await outbox.add(
        'review.requested',
        { type: 'review_request', id, version: 0 },
        {
          reviewRequestId: id,
          contentRevisionId: revision.id,
          manifestHash,
          assigneeCount: parsed.assigneeUserIds.length,
        },
        tx,
        { brandId: revision.brandId },
      );
      return {
        reviewRequestId: id,
        manifestHash,
        revisionState: moved.toState,
        state: 'open' as const,
        version: 0,
      };
    },

    /** Members see the request, its decisions, approvals and links; an external reviewer sees only their frozen manifest. */
    async get(actor: ResolvedActor, input: z.infer<typeof ReviewRequestGet>, tx?: Tx) {
      const parsed = ReviewRequestGet.parse(input);
      const request = await requestsRepo.getById(parsed.reviewRequestId, tx);
      if (actor.kind === 'external_reviewer') {
        await policy.assert(actor, 'review.decide', requestResource(request), {}, tx);
        return toReviewerView(request);
      }
      await policy.assert(actor, 'brand.read', brandResource(request.brandId), {}, tx);
      const revision = await contentService.revisions.read(request.contentRevisionId, tx);
      const decisions = await decisionsRepo.listForRequest(request.brandId, request.id, tx);
      const approvals = (
        await approvalsRepo.listForRevision(request.brandId, request.contentRevisionId, tx)
      ).filter((a) => a.reviewRequestId === request.id);
      const links = await linksRepo.listForRequest(request.id, tx);
      return {
        ...toRequestDto(request),
        revisionState: revision.state,
        decisions: decisions.map(toDecisionDto),
        approvals: approvals.map(toApprovalDto),
        externalLinks: links.map((l) => ({
          id: l.id,
          email: l.email,
          expiresAt: l.expiresAt.toISOString(),
          revokedAt: l.revokedAt ? l.revokedAt.toISOString() : null,
          emailVerifiedAt: l.emailVerifiedAt ? l.emailVerifiedAt.toISOString() : null,
          lastUsedAt: l.lastUsedAt ? l.lastUsedAt.toISOString() : null,
        })),
      };
    },
  },

  decisions: {
    /**
     * Spec 13.2/13.3/5.6: an insert-only decision on exactly the manifest the client saw (expectedManifestHash).
     * `approve` inserts a release_approvals row bound by ApprovalBindingV1 from the frozen manifest and the live
     * rows (a mismatch means the package changed under the reviewer: the request goes stale and the decision is
     * refused); `request_changes` and `reject` (with a reason) move the revision to changes_requested. Decisions
     * on stale, decided or cancelled requests are refused by policy (resource state), which is what makes an
     * external reviewer's link single-use: one request, one decision.
     */
    async submit(
      actor: ResolvedActor,
      input: z.infer<typeof ReviewDecisionSubmit>,
      tx: Tx,
      meta: DecisionMeta = {},
    ) {
      const parsed = ReviewDecisionSubmit.parse(input);
      const request = await requestsRepo.getById(parsed.reviewRequestId, tx);
      const revision = await contentService.revisions.read(request.contentRevisionId, tx);
      const opts = await decisionPolicyOptions(request.brandId, tx);
      await policy.assert(
        actor,
        'review.decide',
        requestResource(request, { state: request.state, authorPrincipalId: revision.authorId }),
        opts,
        tx,
      );
      const deciderKind = deciderKindOf(actor);
      if (parsed.expectedManifestHash !== request.manifestHash)
        throw new ValidationFailedError(
          [{ path: 'expectedManifestHash', issue: 'manifest_hash_mismatch' }],
          'You decided on a different manifest; reload the request',
        );
      if (parsed.decision === 'reject' && !parsed.comment?.trim())
        throw new ValidationFailedError(
          [{ path: 'comment', issue: 'reason_required' }],
          'A rejection needs a reason',
        );
      const link = await touchLink(actor, tx);
      const manifest = FrozenManifestV1.parse(request.frozenManifest);
      const live = await bindingForRevision(revision, manifest.timing, tx);
      const liveManifest = await freezeManifest(revision, manifest.timing, tx);
      if (hashCanonical(liveManifest) !== request.manifestHash) {
        await markStale(request, 'variant_changed', tx);
        throw new ValidationFailedError(
          [{ path: 'reviewRequestId', issue: 'request_stale' }],
          'The package changed after this request was frozen; ask for a new review',
        );
      }
      const decisionId = newId('reviewDecision');
      await decisionsRepo.create(
        {
          id: decisionId,
          brandId: request.brandId,
          reviewRequestId: request.id,
          deciderKind,
          deciderId: actor.id,
          decision: parsed.decision,
          comment: parsed.comment ?? null,
          manifestHash: request.manifestHash,
          verifiedEmail: link?.email ?? null,
          ipHash: meta.ipHash ?? null,
          userAgentHash: meta.userAgentHash ?? null,
        },
        tx,
      );
      const requestState = transition(reviewRequestMachine, request.state, 'decide', 'reviewRequestId');
      await requestsRepo.update(request.id, request.version, { state: requestState }, tx);
      let approvalId: string | null = null;
      let revisionState: string;
      if (parsed.decision === 'approve') {
        approvalId = newId('releaseApproval');
        await approvalsRepo.create(
          {
            id: approvalId,
            brandId: request.brandId,
            contentRevisionId: revision.id,
            reviewRequestId: request.id,
            approverKind: deciderKind,
            approverId: actor.id,
            bindingHash: live.bindingHash,
            binding: live.binding,
            validUntil: parsed.validUntil ? new Date(parsed.validUntil) : null,
            state: 'valid',
            invalidatedReason: null,
          },
          tx,
        );
        revisionState = (await contentService.revisions.transition(revision.id, 'approve', tx)).toState;
        await outbox.add(
          'approval.granted',
          { type: 'release_approval', id: approvalId, version: 0 },
          {
            approvalId,
            contentRevisionId: revision.id,
            reviewRequestId: request.id,
            bindingHash: live.bindingHash,
          },
          tx,
          { brandId: request.brandId },
        );
      } else {
        revisionState = (await contentService.revisions.transition(revision.id, 'request_changes', tx))
          .toState;
      }
      await audit.record(
        actorRef(actor),
        `review.decision.${parsed.decision}`,
        { type: 'review_decision', id: decisionId },
        'allowed',
        tx,
        {
          brandId: request.brandId,
          revisionId: revision.id,
          toState: revisionState,
          reason: parsed.comment ?? null,
        },
      );
      await outbox.add(
        'review.decided',
        { type: 'review_request', id: request.id, version: request.version + 1 },
        {
          reviewRequestId: request.id,
          decisionId,
          decision: parsed.decision,
          contentRevisionId: revision.id,
          approvalId,
        },
        tx,
        { brandId: request.brandId },
      );
      return { decisionId, decision: parsed.decision, approvalId, requestState, revisionState };
    },
  },

  inbox: {
    /**
     * Spec 21.2: open, stale and decided requests the actor may see with the attention each needs (changes
     * requested, stale, invalidated approval, revoked external access). External reviewers have no inbox.
     */
    async list(actor: ResolvedActor, input: z.infer<typeof ReviewInboxList>, tx?: Tx) {
      const parsed = ReviewInboxList.parse(input);
      const ctx = requireTenant();
      let brandIds: 'all' | string[];
      if (parsed.brandId) {
        const brand = await brandService.get(actor, parsed.brandId, tx);
        await policy.assert(actor, 'brand.read', brandResource(brand.id), {}, tx);
        brandIds = [brand.id];
      } else {
        await policy.assert(
          actor,
          'brand.read',
          { type: 'tenant', tenantId: ctx.tenantId, id: ctx.tenantId },
          {},
          tx,
        );
        brandIds = ctx.brandIds === 'all' ? 'all' : [...ctx.brandIds];
      }
      const page = await requestsRepo.listInbox(brandIds, parsed.page, tx);
      const items = [];
      for (const r of page.items) {
        const revision = await contentService.revisions.read(r.contentRevisionId, tx);
        const approvals = (await approvalsRepo.listForRevision(r.brandId, r.contentRevisionId, tx)).filter(
          (a) => a.reviewRequestId === r.id,
        );
        const links = await linksRepo.listForRequest(r.id, tx);
        const revoked = links.filter((l) => l.revokedAt !== null).length;
        items.push({
          ...toRequestDto(r),
          revisionState: revision.state,
          contentPackageId: revision.contentPackageId,
          approvals: approvals.map(toApprovalDto),
          externalLinks: { total: links.length, revoked },
          attention: attentionFor(r, revision.state, approvals, revoked),
        });
      }
      return { items, nextCursor: page.nextCursor };
    },
  },

  externalLinks: {
    /** Spec 5.6: an expiring, revocable link bound to one open request; the token is returned exactly once. */
    async create(actor: ResolvedActor, input: z.infer<typeof ExternalLinkCreate>, tx: Tx) {
      const parsed = ExternalLinkCreate.parse(input);
      const request = await requestsRepo.getById(parsed.reviewRequestId, tx); // foreign → NOT_FOUND
      if (request.state !== 'open')
        throw new ValidationFailedError([{ path: 'reviewRequestId', issue: 'request_not_open' }]);
      if (new Date(parsed.expiresAt).getTime() <= Date.now())
        throw new ValidationFailedError([{ path: 'expiresAt', issue: 'must be in the future' }]);
      const { linkId, token } = await accessService.createExternalReviewerLink(
        actor,
        parsed,
        request.brandId,
        tx,
      );
      return { linkId, token, reviewRequestId: request.id, expiresAt: parsed.expiresAt };
    },

    /** Revocation takes effect on the reviewer's next request (spec 5.6): authentication re-reads the row. */
    async revoke(actor: ResolvedActor, input: z.infer<typeof ExternalLinkRevoke>, tx: Tx) {
      const parsed = ExternalLinkRevoke.parse(input);
      await accessService.revokeExternalReviewerLink(actor, parsed, tx);
      return { linkId: parsed.linkId, revoked: true as const };
    },
  },

  approvals: {
    async get(actor: ResolvedActor, input: z.infer<typeof ApprovalGet>, tx?: Tx) {
      const parsed = ApprovalGet.parse(input);
      const apr = await approvalsRepo.getById(parsed.approvalId, tx);
      await policy.assert(actor, 'brand.read', brandResource(apr.brandId), {}, tx);
      return toApprovalDto(apr);
    },

    /** Spec 13.4 approvals.getById: the scoped row (NOT_FOUND for a foreign id). */
    async getById(approvalId: string, tx?: Tx) {
      return toApprovalDto(await approvalsRepo.getById(approvalId, tx));
    },

    /**
     * Spec 13.1 valid → consumed, for the publishing module once the approved release is out (its approval consumer
     * hook, in the transaction that marks the publication published). The post is already out, so an approval that
     * is no longer valid (invalidated or expired after the release check, or consumed by a repeat) is left as it is.
     */
    /**
     * Spec 13.1/13.2: the approval binds every channel target of the revision, so it is spent (valid → consumed)
     * only once every target has published; with a partial set it stays valid for the remaining channels. Reuse
     * on a channel that already published is refused at dispatch (approval_valid), not here.
     */
    async consume(
      approvalId: string,
      tx: Tx,
      publicationId?: string,
      publishedChannelConnectionIds?: string[],
    ) {
      const apr = await approvalsRepo.getById(approvalId, tx);
      if (apr.state !== 'valid') return { approvalId: apr.id, state: apr.state, version: apr.version };
      if (publishedChannelConnectionIds) {
        const published = new Set(publishedChannelConnectionIds);
        const targets = ApprovalBindingV1.parse(apr.binding).targets.map((t) => t.channelConnectionId);
        if (targets.some((c) => !published.has(c)))
          return { approvalId: apr.id, state: apr.state, version: apr.version };
      }
      const toState = transition(approvalMachine, apr.state, 'consume', 'approvalId');
      await approvalsRepo.setState(apr.id, apr.version, toState, null, tx);
      await audit.record(
        requireTenant().actor,
        'review.approval.consume',
        { type: 'release_approval', id: apr.id },
        'allowed',
        tx,
        {
          brandId: apr.brandId,
          revisionId: apr.contentRevisionId,
          fromState: apr.state,
          toState,
          ...(publicationId ? { publicationId } : {}),
        },
      );
      return { approvalId: apr.id, state: toState, version: apr.version + 1 };
    },

    /** Spec 13.2 eager invalidation (UX): every valid approval of the revision, and its open request goes stale. */
    async invalidateForContentRevisionChange(
      contentRevisionId: string,
      tx: Tx,
      reason: StaleReason = 'variant_changed',
    ) {
      const revision = await contentService.revisions.read(contentRevisionId, tx);
      for (const apr of await approvalsRepo.listValidForRevision(revision.brandId, revision.id, tx))
        await invalidate(apr, 'content_revision_changed', tx);
      for (const r of await requestsRepo.listOpenForRevision(revision.brandId, revision.id, tx))
        await markStale(r, reason, tx);
    },

    /** Spec 11.4 approvals.invalidateForCreativeRevisionChange(doc.id): registered into the creative module's hook. */
    async invalidateForCreativeRevisionChange(documentId: string, tx: Tx) {
      for (const revision of await contentService.revisions.listReferencingCreativeDocument(documentId, tx)) {
        for (const apr of await approvalsRepo.listValidForRevision(revision.brandId, revision.id, tx))
          await invalidate(apr, 'creative_revision_changed', tx);
        for (const r of await requestsRepo.listOpenForRevision(revision.brandId, revision.id, tx))
          await markStale(r, 'creative_changed', tx);
      }
    },

    /**
     * brand.version_published / brand.fact_revoked consumer (brandChangeImpactWorkflowV1): every valid approval
     * and open request of the brand. Idempotent: a second run finds nothing valid or open and counts zero.
     */
    async invalidateForBrandChange(brandId: string, tx: Tx) {
      const approvals = await approvalsRepo.listValidForBrand(brandId, tx);
      for (const apr of approvals) await invalidate(apr, 'brand_changed', tx);
      const requests = await requestsRepo.listOpenForBrand(brandId, tx);
      for (const r of requests) await markStale(r, 'brand_changed', tx);
      return { approvalsInvalidated: approvals.length, requestsStaled: requests.length };
    },
  },

  /** Spec 13.4 mandate path, behind `mandates.managed_autopublish` (default off; spec 22.1 both states tested). */
  mandates: {
    async create(actor: ResolvedActor, input: z.infer<typeof MandateCreate>, tx: Tx) {
      const parsed = MandateCreate.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx); // foreign → NOT_FOUND
      const { tenantId } = requireTenant();
      if (!(await featureFlag.isEnabled('mandates.managed_autopublish', tenantId, tx)))
        throw new PolicyDeniedError(
          'feature_disabled',
          'Managed autopublish is not enabled for this company',
        );
      await policy.assert(actor, 'mandate.manage', brandResource(brand.id), {}, tx);
      if (actor.kind !== 'user')
        throw new PolicyDeniedError('agent_never', 'Only a person can grant a mandate');
      const sp = await principalsRepo.getById(parsed.servicePrincipalId, tx);
      if (sp.status !== 'active')
        throw new ValidationFailedError([{ path: 'servicePrincipalId', issue: 'principal_revoked' }]);
      const windowStart = new Date(parsed.windowStart);
      const windowEnd = new Date(parsed.windowEnd);
      if (windowEnd.getTime() <= windowStart.getTime())
        throw new ValidationFailedError([{ path: 'windowEnd', issue: 'must be after windowStart' }]);
      if (windowEnd.getTime() <= Date.now())
        throw new ValidationFailedError([{ path: 'windowEnd', issue: 'must be in the future' }]);
      const id = newId('publishingMandate');
      await mandatesRepo.create(
        {
          id,
          brandId: brand.id,
          ownerUserId: actor.id,
          servicePrincipalId: sp.id,
          channelConnectionIds: [...new Set(parsed.channelConnectionIds)],
          allowedContentClasses: [...new Set(parsed.allowedContentClasses)],
          sourceRules: parsed.sourceRules,
          maxPostsPerDay: parsed.maxPostsPerDay,
          windowStart,
          windowEnd,
          state: 'active',
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'review.mandate.create',
        { type: 'publishing_mandate', id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          toState: 'active',
        },
      );
      await outbox.add(
        'mandate.changed',
        { type: 'publishing_mandate', id, version: 0 },
        { mandateId: id, state: 'active' },
        tx,
        { brandId: brand.id },
      );
      return { mandateId: id, state: 'active' as const, version: 0 };
    },

    async pause(actor: ResolvedActor, input: z.infer<typeof MandatePause>, tx: Tx) {
      const parsed = MandatePause.parse(input);
      const m = await mandatesRepo.getById(parsed.mandateId, tx);
      await policy.assert(actor, 'mandate.manage', brandResource(m.brandId), {}, tx);
      const toState = transition(mandateMachine, m.state, 'pause', 'mandateId');
      await mandatesRepo.update(m.id, parsed.expectedVersion, { state: toState }, tx);
      await audit.record(
        actorRef(actor),
        'review.mandate.pause',
        { type: 'publishing_mandate', id: m.id },
        'allowed',
        tx,
        {
          brandId: m.brandId,
          fromState: m.state,
          toState,
          expectedVersion: parsed.expectedVersion,
        },
      );
      await outbox.add(
        'mandate.changed',
        { type: 'publishing_mandate', id: m.id, version: parsed.expectedVersion + 1 },
        { mandateId: m.id, state: toState },
        tx,
        { brandId: m.brandId },
      );
      return { mandateId: m.id, state: toState, version: parsed.expectedVersion + 1 };
    },

    async revoke(actor: ResolvedActor, input: z.infer<typeof MandateRevoke>, tx: Tx) {
      const parsed = MandateRevoke.parse(input);
      const m = await mandatesRepo.getById(parsed.mandateId, tx);
      await policy.assert(actor, 'mandate.manage', brandResource(m.brandId), {}, tx);
      const toState = transition(mandateMachine, m.state, 'revoke', 'mandateId');
      await mandatesRepo.update(m.id, parsed.expectedVersion, { state: toState }, tx);
      await audit.record(
        actorRef(actor),
        'review.mandate.revoke',
        { type: 'publishing_mandate', id: m.id },
        'allowed',
        tx,
        {
          brandId: m.brandId,
          fromState: m.state,
          toState,
          reason: parsed.reason ?? null,
          expectedVersion: parsed.expectedVersion,
        },
      );
      await outbox.add(
        'mandate.changed',
        { type: 'publishing_mandate', id: m.id, version: parsed.expectedVersion + 1 },
        { mandateId: m.id, state: toState },
        tx,
        { brandId: m.brandId },
      );
      return { mandateId: m.id, state: toState, version: parsed.expectedVersion + 1 };
    },

    async get(actor: ResolvedActor, input: z.infer<typeof MandateGet>, tx?: Tx) {
      const parsed = MandateGet.parse(input);
      const m = await mandatesRepo.getById(parsed.mandateId, tx);
      await policy.assert(actor, 'brand.read', brandResource(m.brandId), {}, tx);
      return toMandateDto(m);
    },

    /** Spec 13.4 mandates.getById: the scoped row (NOT_FOUND for a foreign id). */
    async getById(mandateId: string, tx?: Tx) {
      return toMandateDto(await mandatesRepo.getById(mandateId, tx));
    },
  },

  /**
   * The content module's revision-change listener (registered by the composition root). A revised package
   * supersedes its revision: the open request goes stale, but an approval keeps binding the superseded revision
   * it was granted on (the package's current content is simply no longer what was approved). A variant change
   * on the same revision invalidates its approvals eagerly; dispatch recomputes the binding either way.
   */
  async onContentRevisionChange(change: RevisionChange, tx: Tx) {
    if (change.reason === 'package_revised') {
      for (const r of await requestsRepo.listOpenForRevision(change.brandId, change.contentRevisionId, tx))
        await markStale(r, 'package_revised', tx);
      return;
    }
    await reviewService.approvals.invalidateForContentRevisionChange(
      change.contentRevisionId,
      tx,
      change.reason,
    );
  },

  evaluateRelease,
  buildLiveBinding,
  hasNoBlockingFindings,
  factRevocationScope,
};
