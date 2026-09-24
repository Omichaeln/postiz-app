import { PolicyDocumentV1, defaultPolicyDocument } from '@oremedia/contracts/brand';
import type { ContentClass } from '@oremedia/contracts/content';
import { CreativeDocumentV1, OperationBatch, RenderValidationResult } from '@oremedia/contracts/creative';
import { OremediaError, PolicyDeniedError, NotFoundError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { PublicationForRelease } from '@oremedia/contracts/publishing';
import type { Check, LiveBinding, ReleaseCheckKey, ReleaseDecision } from '@oremedia/contracts/review';
import { requireTenant, type Tx } from '@oremedia/db';
import { ApprovalBindingV1, bindingHash, withinTiming } from '@oremedia/domain/approval-binding';
import {
  ExternalReviewerLinkRepository,
  policy,
  resolveTenantContext,
  type Principal,
} from '@oremedia/module-access';
import {
  ApprovedFactRepository,
  BrandVersionRepository,
  PolicyVersionRepository,
  brandService,
} from '@oremedia/module-brand';
import {
  contentClassOf,
  contentService,
  hashesForVariant,
  type ChannelVariantDto,
} from '@oremedia/module-content';
import {
  CreativeRevisionRepository,
  RenderedExportRepository,
  TemplateVersionRepository,
  validateAgainstBrand,
} from '@oremedia/module-creative';
import { killSwitch } from '@oremedia/module-operations';
import {
  PublishingMandateRepository,
  ReleaseApprovalRepository,
  ReviewRequestRepository,
} from './repositories';

const approvalsRepo = new ReleaseApprovalRepository();
const requestsRepo = new ReviewRequestRepository();
const mandatesRepo = new PublishingMandateRepository();
// Read-only views of other modules' rows through their public index (spec 4.2: never their tables).
const brandVersionsRepo = new BrandVersionRepository();
const policyVersionsRepo = new PolicyVersionRepository();
const factsRepo = new ApprovedFactRepository();
const creativeRevisionsRepo = new CreativeRevisionRepository();
const exportsRepo = new RenderedExportRepository();
const templateVersionsRepo = new TemplateVersionRepository();
const linksRepo = new ExternalReviewerLinkRepository();

export type ApprovalRow = Awaited<ReturnType<typeof approvalsRepo.getById>>;
export type MandateRow = Awaited<ReturnType<typeof mandatesRepo.getById>>;
type Revision = Awaited<ReturnType<typeof contentService.revisions.read>>;

// ---- cross-module hooks (same pattern as the creative module's registerAssetAuthoriser) ----

/**
 * Spec 13.4 checks owned by other modules: `channel_active` (publishing.channelUsable), `capability_valid`
 * (providers.validateVariant through the publishing module) and the mandate daily quota (publications per
 * mandate per day). The composition root registers them; the default is loud so a composition mistake cannot
 * pass as "allowed".
 */
export interface ReleaseCheckers {
  channelUsable(channelConnectionId: string, tx?: Tx): Promise<boolean>;
  validateVariant(channelVariantId: string, tx?: Tx): Promise<boolean>;
  countForMandateOnDay(mandateId: string, at: Date, tx?: Tx): Promise<number>;
  /** Whether another publication already published on this channel under this approval (single use per target). */
  publishedElsewhereForApprovalChannel(
    approvalId: string,
    channelConnectionId: string,
    exceptPublicationId: string,
    tx?: Tx,
  ): Promise<boolean>;
}
const unregisteredCheckers: ReleaseCheckers = {
  channelUsable: async () => {
    throw new Error('release checkers not registered (composition root must call registerReleaseCheckers)');
  },
  validateVariant: async () => {
    throw new Error('release checkers not registered (composition root must call registerReleaseCheckers)');
  },
  countForMandateOnDay: async () => {
    throw new Error('release checkers not registered (composition root must call registerReleaseCheckers)');
  },
  publishedElsewhereForApprovalChannel: async () => {
    throw new Error('release checkers not registered (composition root must call registerReleaseCheckers)');
  },
};
let checkers: ReleaseCheckers = unregisteredCheckers;
export const registerReleaseCheckers = (c: ReleaseCheckers): void => {
  checkers = c;
};
/** Test seam: back to the loud default. */
export const resetReleaseCheckers = (): void => {
  checkers = unregisteredCheckers;
};

/** Spec 13.4 assets.allUsable: assets.authoriseUse for every asset version an export was rendered from. */
export type ReleaseAssetPurpose = 'creative' | 'font';
export type ReleaseAssetAuthoriser = (
  assetVersionId: string,
  ctx: {
    tenantId: string;
    brandId: string;
    purpose: ReleaseAssetPurpose;
    channelConnectionIds: readonly string[];
    scheduledFor: Date;
  },
  tx?: Tx,
) => Promise<void>;
const unregisteredAuthoriser: ReleaseAssetAuthoriser = async () => {
  throw new Error('asset authoriser not registered (composition root must call registerAssetAuthoriser)');
};
let assetAuthoriser: ReleaseAssetAuthoriser = unregisteredAuthoriser;
export const registerAssetAuthoriser = (fn: ReleaseAssetAuthoriser): void => {
  assetAuthoriser = fn;
};
export const resetAssetAuthoriser = (): void => {
  assetAuthoriser = unregisteredAuthoriser;
};

// ---- actors re-resolved at the point of effect (spec 5.2: never a cached decision) ----

function principalFor(
  actor: { kind: string; id: string },
  tenantId: string,
  correlationId: string,
): Principal {
  switch (actor.kind) {
    case 'user':
      return {
        kind: 'user',
        userId: actor.id,
        sessionId: `release:${correlationId}`,
        selectedTenantId: tenantId,
      };
    case 'service_principal':
      return {
        kind: 'api_client',
        apiClientId: `release:${correlationId}`,
        servicePrincipalId: actor.id,
        tenantId,
        scopes: [],
      };
    default:
      throw new PolicyDeniedError(
        'actor_kind_not_allowed_in_release',
        `Actor kind ${actor.kind} cannot evaluate a release`,
      );
  }
}

/** The tenant context's actor as a full ResolvedActor (the scheduler or the reviewer running the command). */
async function contextActor(tx?: Tx): Promise<ResolvedActor> {
  const ctx = requireTenant();
  return (
    await resolveTenantContext(
      principalFor(ctx.actor, ctx.tenantId, ctx.correlationId),
      ctx.tenantId,
      ctx.correlationId,
      tx,
    )
  ).actor;
}

/**
 * Spec 13.4 approver_still_authorised / owner_still_authorised: the approver's *current* membership, grants and
 * link, never the decision recorded at approval time. A principal that no longer resolves is not authorised.
 */
export async function stillAuthorised(
  principal: { kind: 'user' | 'external_reviewer' | 'service_principal'; id: string },
  action: 'review.decide' | 'mandate.manage',
  brandId: string,
  tx?: Tx,
): Promise<boolean> {
  const ctx = requireTenant();
  try {
    if (principal.kind === 'external_reviewer') {
      const link = await linksRepo.findById(principal.id, tx);
      if (!link || link.brandId !== brandId) return false;
      // A link that has since expired does not void the decision it recorded; revocation by the team does.
      const actor: ResolvedActor = {
        kind: 'external_reviewer',
        id: link.id,
        tenantId: link.tenantId,
        reviewRequestId: link.reviewRequestId,
        brandId: link.brandId,
        revoked: link.revokedAt !== null,
        expired: false,
      };
      const d = await policy.decide(
        actor,
        action,
        {
          type: 'review_request',
          tenantId: ctx.tenantId,
          brandId,
          id: link.reviewRequestId,
          reviewRequestId: link.reviewRequestId,
        },
        {},
        tx,
      );
      return d.allowed;
    }
    const { actor } = await resolveTenantContext(
      principalFor(principal, ctx.tenantId, ctx.correlationId),
      ctx.tenantId,
      ctx.correlationId,
      tx,
    );
    return await policy.stillHas(actor, action, brandId, tx);
  } catch (err) {
    if (err instanceof OremediaError) return false; // membership gone, principal revoked, link missing
    throw err;
  }
}

// ---- the binding, computed one way for the manifest, the approval and dispatch (spec 13.2) ----

/**
 * The binding of a revision from CURRENT rows: the brand's published version and active policy (not the ids the
 * revision was written against, so a brand change after approval changes the hash), every variant's caption, alt
 * texts, settings and export hashes in channel order, and the timing the reviewer approved.
 */
export async function bindingForRevision(
  revision: Revision,
  timing: ApprovalBindingV1['timing'],
  tx?: Tx,
): Promise<LiveBinding & { variants: ChannelVariantDto[] }> {
  const variants = await contentService.variants.listForRevision(revision.id, tx);
  const published = await brandVersionsRepo.findPublished(revision.brandId, tx);
  const active = await policyVersionsRepo.findActive(revision.brandId, tx);
  const binding = ApprovalBindingV1.parse({
    v: 1,
    tenantId: revision.tenantId,
    brandId: revision.brandId,
    contentRevisionId: revision.id,
    brandVersionId: published?.id ?? '',
    policyVersionId: active?.id ?? '',
    targets: variants.map((v) => ({ channelConnectionId: v.channelConnectionId, ...hashesForVariant(v) })),
    timing,
  });
  return { binding, bindingHash: bindingHash(binding), variants };
}

/**
 * Spec 13.4 buildLiveBinding(pub): from current rows, never from the workflow payload. The timing is the one the
 * approval's request froze (a stored, immutable row); a mandate publication has no request, so its timing is the
 * publication's own scheduledFor.
 */
export async function buildLiveBinding(pub: PublicationForRelease, tx?: Tx) {
  const revision = await contentService.revisions.read(pub.contentRevisionId, tx);
  if (revision.brandId !== pub.brandId) throw new NotFoundError('ContentRevision', pub.contentRevisionId);
  const approval =
    pub.authority === 'approval' && pub.approvalId ? await approvalsRepo.findById(pub.approvalId, tx) : null;
  const request = approval ? await requestsRepo.findById(approval.reviewRequestId, tx) : null;
  const timing: ApprovalBindingV1['timing'] = request
    ? request.frozenManifest.timing
    : { kind: 'exact', at: new Date(pub.scheduledFor).toISOString() };
  const live = await bindingForRevision(revision, timing, tx);
  return { ...live, revision, approval };
}

// ---- brand review (spec 13.4 brand_review_clean) ----

/**
 * Deterministic brand review of the revision's pinned creative documents against the brand's current snapshot
 * (validateAgainstBrand) plus the render-time findings stored on the exports its variants publish. The brand's
 * active policy decides whether warnings block too (blockOnBrandReviewSeverity).
 */
export async function hasNoBlockingFindings(contentRevisionId: string, tx?: Tx): Promise<boolean> {
  const revision = await contentService.revisions.read(contentRevisionId, tx);
  const actor = await contextActor(tx);
  const snapshot = await brandService.resolveBrandSnapshot(actor, { brandId: revision.brandId }, tx);
  const blocks = (severity: string) =>
    severity === 'blocking' ||
    (snapshot.policy.reviewThresholds.blockOnBrandReviewSeverity === 'warning' && severity === 'warning');
  for (const id of revision.creativeRevisionIds) {
    const creative = await creativeRevisionsRepo.getById(id, tx);
    const findings = validateAgainstBrand(CreativeDocumentV1.parse(creative.snapshot), snapshot);
    if (findings.some((f) => blocks(f.severity))) return false;
  }
  const exportIds = new Set(
    (await contentService.variants.listForRevision(revision.id, tx)).flatMap((v) => v.exportIds),
  );
  if (exportIds.size) {
    for (const e of await exportsRepo.listByIds(revision.brandId, [...exportIds], tx)) {
      const validation = RenderValidationResult.parse(e.validation);
      if (validation.findings.some((f) => blocks(f.severity))) return false;
    }
  }
  return true;
}

/** Spec 13.4 mandate_sources onlyApprovedTemplates: every template the pinned creative revisions applied is still approved. */
async function templatesStillApproved(revision: Revision, tx?: Tx): Promise<boolean> {
  for (const id of revision.creativeRevisionIds) {
    const creative = await creativeRevisionsRepo.getById(id, tx);
    for (const op of OperationBatch.parse(creative.operations).operations) {
      if (op.op !== 'applyTemplate') continue;
      const tv = await templateVersionsRepo.findById(op.templateVersionId, tx);
      if (!tv || tv.state !== 'approved') return false;
    }
  }
  return true;
}

/** Spec 13.4 assets.allUsable: every asset version and font the publication's exports were rendered from. */
async function assetsUsable(
  pub: PublicationForRelease,
  variant: ChannelVariantDto | undefined,
  at: Date,
  tx?: Tx,
): Promise<boolean> {
  if (!variant) return false;
  const exports = await exportsRepo.listByIds(pub.brandId, variant.exportIds, tx);
  if (exports.length !== variant.exportIds.length) return false;
  const ctx = {
    tenantId: pub.tenantId,
    brandId: pub.brandId,
    channelConnectionIds: [pub.channelConnectionId],
    scheduledFor: at,
  };
  try {
    for (const e of exports) {
      for (const a of e.manifest.assets)
        await assetAuthoriser(a.assetVersionId, { ...ctx, purpose: 'creative' }, tx);
      for (const f of e.manifest.fonts)
        await assetAuthoriser(f.assetVersionId, { ...ctx, purpose: 'font' }, tx);
    }
    return true;
  } catch (err) {
    if (err instanceof OremediaError) return false; // RIGHTS_INELIGIBLE, NOT_FOUND: never a silent publish
    throw err;
  }
}

const check = (key: ReleaseCheckKey, ok: boolean): Check => ({ key, ok });

/**
 * Spec 13.4, literally: the approval path or the mandate path, then the checks every release needs. A failed
 * check is reported by key and never dropped; the publishing workflow moves the publication to `held` with the
 * reasons. Runs in the caller's transaction (the dispatch activity's) against current rows.
 */
export async function evaluateRelease(
  pub: PublicationForRelease,
  at: Date,
  tx?: Tx,
): Promise<ReleaseDecision> {
  const { tenantId } = requireTenant();
  if (pub.tenantId !== tenantId) throw new NotFoundError('Publication', pub.id);
  const live = await buildLiveBinding(pub, tx); // from current rows, not from the workflow payload
  const checks: Check[] = [];
  const effectiveFacts = await factsRepo.listEffective(pub.brandId, at, tx);
  const effectiveIds = new Set(effectiveFacts.map((f) => f.id));
  const factsOk = live.revision.factRefs.every((id) => effectiveIds.has(id));
  const variant = live.variants.find((v) => v.id === pub.channelVariantId);
  const assetsOk = await assetsUsable(pub, variant, at, tx);

  if (pub.authority === 'approval') {
    const apr = live.approval;
    checks.push(
      check(
        'approval_valid',
        apr?.state === 'valid' &&
          !(await checkers.publishedElsewhereForApprovalChannel(apr.id, pub.channelConnectionId, pub.id, tx)),
      ),
    );
    checks.push(check('approval_matches', apr !== null && apr.bindingHash === live.bindingHash));
    checks.push(
      check(
        'approval_not_expired',
        apr !== null && (!apr.validUntil || apr.validUntil.getTime() > at.getTime()),
      ),
    );
    checks.push(
      check(
        'approver_still_authorised',
        apr !== null &&
          (await stillAuthorised(
            { kind: apr.approverKind, id: apr.approverId },
            'review.decide',
            pub.brandId,
            tx,
          )),
      ),
    );
    checks.push(check('timing_within_binding', withinTiming(live.binding.timing, at)));
  } else {
    const m = pub.mandateId ? await mandatesRepo.findById(pub.mandateId, tx) : null;
    const clean = await hasNoBlockingFindings(pub.contentRevisionId, tx);
    const classOf: ContentClass = contentClassOf(
      effectiveFacts.filter((f) => live.revision.factRefs.includes(f.id)).map((f) => f.kind),
    );
    checks.push(
      check(
        'mandate_active',
        m !== null &&
          m.state === 'active' &&
          m.windowStart.getTime() <= at.getTime() &&
          at.getTime() <= m.windowEnd.getTime(),
      ),
    );
    checks.push(
      check('mandate_channel', m !== null && m.channelConnectionIds.includes(pub.channelConnectionId)),
    );
    checks.push(check('mandate_content_class', m !== null && m.allowedContentClasses.includes(classOf)));
    checks.push(
      check(
        'mandate_daily_quota',
        m !== null && (await checkers.countForMandateOnDay(m.id, at, tx)) < m.maxPostsPerDay,
      ),
    );
    checks.push(
      check(
        'mandate_sources',
        m !== null &&
          (!m.sourceRules.onlyApprovedFacts || factsOk) &&
          (!m.sourceRules.onlyApprovedAssets || assetsOk) &&
          (!m.sourceRules.onlyApprovedTemplates || (await templatesStillApproved(live.revision, tx))) &&
          (!m.sourceRules.requireBrandReviewClean || clean),
      ),
    );
    checks.push(
      check(
        'owner_still_authorised',
        m !== null &&
          (await stillAuthorised({ kind: 'user', id: m.ownerUserId }, 'mandate.manage', pub.brandId, tx)),
      ),
    );
    checks.push(check('kill_switch_off', !(await killSwitch.isOn('release_dispatch', pub.brandId, tx))));
    checks.push(check('brand_review_clean', clean));
  }

  checks.push(check('channel_active', await checkers.channelUsable(pub.channelConnectionId, tx)));
  checks.push(check('assets_rights_valid', assetsOk));
  checks.push(check('facts_valid', factsOk)); // expired offers block
  checks.push(check('capability_valid', await checkers.validateVariant(pub.channelVariantId, tx)));

  const failed = checks.filter((c) => !c.ok);
  return failed.length ? { allow: false, hold: true, reasons: failed.map((c) => c.key) } : { allow: true };
}

/**
 * Spec 8.2 brand.fact_revoked: what the revocation reaches (the in-review or approved revisions citing the fact,
 * the ones a scheduled publication can carry) and what the brand's active policy says to do with them:
 * holdOnDependencyRevocation (the default) holds, otherwise the publishing module only flags.
 */
export async function factRevocationScope(brandId: string, factId: string, tx?: Tx) {
  const active = await policyVersionsRepo.findActive(brandId, tx);
  const doc = active ? PolicyDocumentV1.parse(active.document) : defaultPolicyDocument();
  const revisions = await contentService.revisions.listCitingFact(brandId, factId, tx);
  return { hold: doc.holdOnDependencyRevocation, contentRevisionIds: revisions.map((r) => r.id) };
}

/** Spec 5.5 obligations for decisions: the brand's active policy (distinct approver, MFA), or the defaults. */
export async function decisionPolicyOptions(brandId: string, tx?: Tx) {
  const active = await policyVersionsRepo.findActive(brandId, tx);
  const doc = active ? PolicyDocumentV1.parse(active.document) : null;
  return {
    requireDistinctApprover: doc?.requireDistinctApprover ?? false,
    mfaRequired: doc?.mfaRequired ?? false,
  };
}
