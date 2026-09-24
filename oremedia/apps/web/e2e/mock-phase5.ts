import { createHash, randomUUID } from 'node:crypto';
import { TRPCError, type AnyTRPCProcedure } from '@trpc/server';
import { z } from 'zod';
import { ExternalLinkCreate, ExternalLinkRevoke } from '@oremedia/contracts/access';
import { CalendarRange, ChannelVariantGet, ContentRevisionGet } from '@oremedia/contracts/content';
import {
  ConflictError,
  NotFoundError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import {
  CancelCommand,
  ChannelList,
  PublicationEvidence,
  PublicationGet,
  PublicationList,
  ReconcileCommand,
  RescheduleCommand,
  ScheduleCommand,
  type PublicationState,
} from '@oremedia/contracts/publishing';
import {
  ApprovalGet,
  ReviewDecisionSubmit,
  ReviewInboxList,
  ReviewRequestCreate,
  ReviewRequestGet,
  type FrozenManifestV1,
  type InboxAttention,
  type ReviewRequestState,
  type StaleReason,
} from '@oremedia/contracts/review';
import type { MockBuilders, t } from './mock-api';

/**
 * Phase 5 slice of the UI-only transport (see mock-api.ts): the content calendar, publications, channels, review
 * requests, decisions and external reviewer links with the same procedure paths, DTO shapes and error envelope as
 * apps/api. Seeded relative to "now" so the calendar's current day shows every required state (spec 21.2). A test
 * double, never a second implementation.
 */
export const P5 = {
  brandId: 'brd_e2e',
  channels: { ok: 'cc_linkedin', expired: 'cc_instagram', two: 'cc_x' },
  variants: { ok: 'cv_ok', invalid: 'cv_invalid', onExpired: 'cv_expired' },
  revisions: { one: 'cr_1', two: 'cr_2', three: 'cr_3', changes: 'cr_4' },
  publications: {
    held: 'pub_held',
    unknown: 'pub_unknown',
    dispatching: 'pub_dispatching',
    published: 'pub_published',
    failed: 'pub_failed',
  },
  requests: {
    open: 'rr_open',
    stale: 'rr_stale',
    changes: 'rr_changes',
    invalidated: 'rr_invalidated',
    revoked: 'rr_revoked',
    approved: 'rr_approved',
  },
  links: { revoked: 'rl_already_revoked', active: 'rl_active_link', expired: 'rl_expired_link' },
  approvalId: 'apr_seed',
};

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const now = () => new Date().toISOString();
const rid = (p: string) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const todayAt = (hour: number) => {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

export interface Channel {
  id: string;
  brandId: string;
  providerKey: string;
  remoteAccountId: string;
  displayName: string;
  grantedScopes: string[];
  missingScopes: string[];
  status: 'active' | 'refresh_needed' | 'reconnect_needed' | 'disabled';
  tokenExpiresAt: string | null;
  capabilityVersion: number;
  usable: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface Revision {
  id: string;
  tenantId: string;
  brandId: string;
  contentPackageId: string;
  number: number;
  brandVersionId: string;
  policyVersionId: string;
  copy: { schemaVersion: 1; master: { text: string; factRefs: string[] } };
  creativeRevisionIds: string[];
  factRefs: string[];
  contentHash: string;
  state: 'draft' | 'in_review' | 'changes_requested' | 'approved' | 'superseded';
  authorKind: 'user';
  authorId: string;
  agentRunId: null;
  createdAt: string;
  updatedAt: string;
  version: number;
}
export interface Variant {
  id: string;
  tenantId: string;
  brandId: string;
  contentPackageId: string;
  contentRevisionId: string;
  channelConnectionId: string;
  text: string;
  altTexts: string[];
  settings: Record<string, unknown>;
  exportIds: string[];
  exportHashes: string[];
  capabilityVersion: number;
  validation: { ok: boolean; issues: Array<{ path?: string; issue: string }> };
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface Attempt {
  id: string;
  publicationId: string;
  attemptNumber: number;
  fencingToken: number;
  requestFingerprint: string;
  providerIdempotencyKey: string;
  startedAt: string;
  sentAt: string | null;
  finishedAt: string | null;
  outcome: 'accepted' | 'pending' | 'rejected' | 'retryable_error' | 'unknown' | null;
  errorCode: string | null;
  errorDetail: string | null;
  remoteJobId: string | null;
  remotePostId: string | null;
}
export interface Publication {
  id: string;
  brandId: string;
  contentPackageId: string;
  contentRevisionId: string;
  channelVariantId: string;
  channelConnectionId: string;
  occurrenceKey: string;
  authority: 'approval' | 'mandate';
  approvalId: string | null;
  mandateId: string | null;
  scheduledFor: string;
  state: PublicationState;
  stateReason: string | null;
  holdReasons: string[];
  remotePostId: string | null;
  remoteUrl: string | null;
  fencingToken: number | null;
  claimedAt: string | null;
  scheduledByKind: 'user';
  scheduledById: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  attempts: Attempt[];
}
interface Request {
  id: string;
  brandId: string;
  contentRevisionId: string;
  frozenManifest: FrozenManifestV1;
  manifestHash: string;
  assignees: string[];
  dueAt: string | null;
  state: ReviewRequestState;
  staleReason: StaleReason | null;
  requestedByKind: 'user';
  requestedById: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
interface Decision {
  id: string;
  reviewRequestId: string;
  deciderKind: 'user' | 'external_reviewer';
  deciderId: string;
  decision: 'approve' | 'request_changes' | 'reject';
  comment: string | null;
  manifestHash: string;
  verifiedEmail: string | null;
  createdAt: string;
}
interface Approval {
  id: string;
  brandId: string;
  contentRevisionId: string;
  reviewRequestId: string;
  approverKind: 'user' | 'external_reviewer';
  approverId: string;
  bindingHash: string;
  binding: Record<string, unknown>;
  validUntil: string | null;
  state: 'valid' | 'consumed' | 'invalidated' | 'expired';
  invalidatedReason: string | null;
  createdAt: string;
  version: number;
}
export interface ReviewerLink {
  id: string;
  reviewRequestId: string;
  brandId: string;
  email: string;
  token: string;
  expiresAt: string;
  revokedAt: string | null;
  emailVerifiedAt: string | null;
  lastUsedAt: string | null;
}

const manifestFor = (revision: Revision, variants: Variant[]): FrozenManifestV1 => ({
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
    settingsHash: hash(v.settings),
  })),
  timing: { kind: 'exact', at: todayAt(15) },
  brandVersionId: 'bv_e2e',
  policyVersionId: 'pv_e2e',
});

export class Phase5Backend {
  readonly channels = new Map<string, Channel>();
  readonly revisions = new Map<string, Revision>();
  readonly variants = new Map<string, Variant>();
  readonly publications = new Map<string, Publication>();
  readonly requests = new Map<string, Request>();
  readonly decisions: Decision[] = [];
  readonly approvals: Approval[] = [];
  readonly links = new Map<string, ReviewerLink>();
  /** Test hook: fail the next schedule with an INTERNAL envelope (the UI retries the same intent). */
  failNextSchedule = false;
  /** Packages the calendar range reports (phase 6 registers its content packages here). */
  calendarPackages: (from: number, to: number) => unknown[] = () => [];
  /** Tells phase 6 that a revision moved, so its content package follows (review requested, approved, …). */
  packageStateChanged: (contentPackageId: string, state: 'draft' | 'in_review' | 'approved') => void =
    () => {};

  /**
   * One company's brand: every row carries its tenant and brand, and a second company is a second instance with its
   * own stores (mock-api.ts routes by the X-Oremedia-Tenant header), so nothing of one company is reachable from the
   * other. `seed: false` starts empty (a second company seeds its own few rows).
   */
  constructor(
    readonly tenantId = 'ten_e2e',
    readonly brandId = P5.brandId,
    seed = true,
  ) {
    if (seed) this.seed();
  }

  linkByToken(token: string): ReviewerLink | null {
    for (const l of this.links.values()) if (l.token === token) return l;
    return null;
  }

  /** Test backdoor: the workflow moved the publication (published, held with reasons, outcome unknown, ...). */
  transition(publicationId: string, patch: Partial<Publication>): Publication {
    const p = this.publication(publicationId);
    Object.assign(p, patch, { updatedAt: now(), version: p.version + 1 });
    return p;
  }

  /**
   * Test backdoor: the publish workflow reached the publication's time and ran the release check (spec 13.4). The
   * approval binds the exact revision it was given on; when the package has moved past it (a post-approval edit) the
   * binding no longer matches and the publication is held with `approval_matches`, otherwise it is claimed.
   */
  releaseDue(publicationId: string): Publication {
    const p = this.publication(publicationId);
    if (p.state !== 'scheduled') return p;
    const approval = this.approvals.find((a) => a.id === p.approvalId);
    const revision = this.revisions.get(p.contentRevisionId);
    const matches =
      p.authority !== 'approval' ||
      (approval !== undefined &&
        approval.contentRevisionId === p.contentRevisionId &&
        revision?.state === 'approved');
    return matches
      ? this.transition(p.id, { state: 'dispatching', fencingToken: 1, claimedAt: now() })
      : this.transition(p.id, {
          state: 'held',
          stateReason: 'release_policy',
          holdReasons: ['approval_matches'],
        });
  }

  /**
   * Spec 13.2 eager invalidation (UX only; dispatch still recomputes the binding): a revision was superseded, so its
   * valid approvals are invalidated and its open requests go stale with the reason.
   */
  revisionSuperseded(revisionId: string): void {
    for (const a of this.approvals)
      if (a.contentRevisionId === revisionId && a.state === 'valid')
        Object.assign(a, {
          state: 'invalidated',
          invalidatedReason: 'content_revision_changed',
          version: a.version + 1,
        });
    for (const r of this.requests.values())
      if (r.contentRevisionId === revisionId && r.state === 'open')
        Object.assign(r, {
          state: 'stale',
          staleReason: 'package_revised',
          updatedAt: now(),
          version: r.version + 1,
        });
  }

  publication(id: string): Publication {
    const p = this.publications.get(id);
    if (!p) throw new NotFoundError('Publication', id);
    return p;
  }
  request(id: string): Request {
    const r = this.requests.get(id);
    if (!r) throw new NotFoundError('ReviewRequest', id);
    return r;
  }

  addChannel(
    id: string,
    providerKey: string,
    displayName: string,
    status: Channel['status'],
    tokenExpiresAt: string | null,
  ) {
    this.channels.set(id, {
      id,
      brandId: this.brandId,
      providerKey,
      remoteAccountId: `acct_${providerKey}`,
      displayName,
      grantedScopes: ['publish'],
      missingScopes: [],
      status,
      tokenExpiresAt,
      capabilityVersion: 1,
      usable: status === 'active',
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    });
  }
  private revision(id: string, packageId: string, state: Revision['state'], text: string) {
    const copy = { schemaVersion: 1 as const, master: { text, factRefs: [] } };
    this.revisions.set(id, {
      id,
      tenantId: this.tenantId,
      brandId: this.brandId,
      contentPackageId: packageId,
      number: 1,
      brandVersionId: 'bv_e2e',
      policyVersionId: 'pv_e2e',
      copy,
      creativeRevisionIds: ['rev_seed'],
      factRefs: [],
      contentHash: hash(copy),
      state,
      authorKind: 'user',
      authorId: 'usr_author',
      agentRunId: null,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    });
  }
  private variant(id: string, revisionId: string, channelId: string, validation: Variant['validation']) {
    const r = this.revisions.get(revisionId) as Revision;
    this.variants.set(id, {
      id,
      tenantId: this.tenantId,
      brandId: this.brandId,
      contentPackageId: r.contentPackageId,
      contentRevisionId: revisionId,
      channelConnectionId: channelId,
      text: r.copy.master.text,
      altTexts: ['Product photo'],
      settings: {},
      exportIds: ['exp_seed'],
      exportHashes: [hash('exp_seed')],
      capabilityVersion: 1,
      validation,
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    });
  }
  private publicationRow(
    id: string,
    revisionId: string,
    channelId: string,
    scheduledFor: string,
    state: PublicationState,
    extra: Partial<Publication> = {},
  ) {
    const r = this.revisions.get(revisionId) as Revision;
    this.publications.set(id, {
      id,
      brandId: this.brandId,
      contentPackageId: r.contentPackageId,
      contentRevisionId: revisionId,
      channelVariantId: `cv_for_${id}`,
      channelConnectionId: channelId,
      occurrenceKey: 'default',
      authority: 'approval',
      approvalId: P5.approvalId,
      mandateId: null,
      scheduledFor,
      state,
      stateReason: null,
      holdReasons: [],
      remotePostId: null,
      remoteUrl: null,
      fencingToken: null,
      claimedAt: null,
      scheduledByKind: 'user',
      scheduledById: 'usr_e2e',
      createdAt: now(),
      updatedAt: now(),
      version: 1,
      attempts: [],
      ...extra,
    });
  }
  private requestRow(
    id: string,
    revisionId: string,
    state: ReviewRequestState,
    staleReason: StaleReason | null = null,
  ) {
    const r = this.revisions.get(revisionId) as Revision;
    const variants = [...this.variants.values()].filter((v) => v.contentRevisionId === revisionId);
    const frozenManifest = manifestFor(r, variants);
    this.requests.set(id, {
      id,
      brandId: this.brandId,
      contentRevisionId: revisionId,
      frozenManifest,
      manifestHash: hash(frozenManifest),
      assignees: [],
      dueAt: daysFromNow(3),
      state,
      staleReason,
      requestedByKind: 'user',
      requestedById: 'usr_author',
      createdAt: now(),
      updatedAt: now(),
      version: 1,
    });
  }
  private approval(requestId: string, state: Approval['state'], invalidatedReason: string | null = null) {
    const r = this.request(requestId);
    this.approvals.push({
      id: rid('apr'),
      brandId: this.brandId,
      contentRevisionId: r.contentRevisionId,
      reviewRequestId: r.id,
      approverKind: 'user',
      approverId: 'usr_reviewer',
      bindingHash: hash(r.manifestHash),
      binding: { v: 1 },
      validUntil: null,
      state,
      invalidatedReason,
      createdAt: now(),
      version: 1,
    });
  }
  private link(
    id: string,
    requestId: string,
    token: string,
    email: string,
    expiresAt: string,
    revokedAt: string | null = null,
  ) {
    this.links.set(id, {
      id,
      reviewRequestId: requestId,
      brandId: this.brandId,
      email,
      token,
      expiresAt,
      revokedAt,
      emailVerifiedAt: null,
      lastUsedAt: null,
    });
  }

  private seed() {
    this.addChannel(P5.channels.ok, 'linkedin', 'Acme LinkedIn', 'active', daysFromNow(30));
    this.addChannel(P5.channels.expired, 'instagram', 'Acme Instagram', 'reconnect_needed', daysFromNow(-1));
    this.addChannel(P5.channels.two, 'x', 'Acme X', 'active', daysFromNow(30));
    this.revision(P5.revisions.one, 'pkg_1', 'in_review', 'Autumn offer: 20% off all lamps this week.');
    this.revision(P5.revisions.two, 'pkg_2', 'approved', 'Meet the team behind the workshop.');
    this.revision(P5.revisions.three, 'pkg_3', 'approved', 'New arrivals in the showroom.');
    this.revision(P5.revisions.changes, 'pkg_4', 'changes_requested', 'Workshop dates for October.');
    this.variant(P5.variants.ok, P5.revisions.one, P5.channels.ok, { ok: true, issues: [] });
    this.variant(P5.variants.invalid, P5.revisions.one, P5.channels.two, {
      ok: false,
      issues: [
        { path: 'exports.0', issue: 'image is 12.4 MB; the channel accepts at most 8 MB' },
        { path: 'text', issue: 'caption is 310 characters; the channel allows 280' },
      ],
    });
    this.variant(P5.variants.onExpired, P5.revisions.one, P5.channels.expired, { ok: true, issues: [] });
    this.publicationRow(P5.publications.held, P5.revisions.two, P5.channels.ok, todayAt(9), 'held', {
      stateReason: 'release_policy',
      holdReasons: ['approval_matches', 'facts_valid'],
    });
    this.publicationRow(
      P5.publications.unknown,
      P5.revisions.two,
      P5.channels.two,
      todayAt(10),
      'outcome_unknown',
      {
        stateReason: 'worker_lost',
        fencingToken: 1,
        claimedAt: todayAt(10),
        attempts: [
          {
            id: 'att_unknown_1',
            publicationId: P5.publications.unknown,
            attemptNumber: 1,
            fencingToken: 1,
            requestFingerprint: hash('fp'),
            providerIdempotencyKey: 'pik_1',
            startedAt: todayAt(10),
            sentAt: todayAt(10),
            finishedAt: null,
            outcome: null,
            errorCode: null,
            errorDetail: null,
            remoteJobId: null,
            remotePostId: null,
          },
        ],
      },
    );
    this.publicationRow(
      P5.publications.dispatching,
      P5.revisions.three,
      P5.channels.ok,
      todayAt(11),
      'dispatching',
      {
        fencingToken: 2,
        claimedAt: todayAt(11),
      },
    );
    this.publicationRow(
      P5.publications.published,
      P5.revisions.three,
      P5.channels.two,
      todayAt(11),
      'published',
      {
        remotePostId: 'x_123',
        remoteUrl: 'https://x.example/status/123',
        attempts: [
          {
            id: 'att_pub_1',
            publicationId: P5.publications.published,
            attemptNumber: 1,
            fencingToken: 1,
            requestFingerprint: hash('fp2'),
            providerIdempotencyKey: 'pik_2',
            startedAt: todayAt(11),
            sentAt: todayAt(11),
            finishedAt: todayAt(11),
            outcome: 'accepted',
            errorCode: null,
            errorDetail: null,
            remoteJobId: null,
            remotePostId: 'x_123',
          },
        ],
      },
    );
    this.publicationRow(
      P5.publications.failed,
      P5.revisions.three,
      P5.channels.expired,
      todayAt(11),
      'failed',
      {
        stateReason: 'rejected',
        attempts: [
          {
            id: 'att_fail_1',
            publicationId: P5.publications.failed,
            attemptNumber: 1,
            fencingToken: 1,
            requestFingerprint: hash('fp3'),
            providerIdempotencyKey: 'pik_3',
            startedAt: todayAt(11),
            sentAt: todayAt(11),
            finishedAt: todayAt(11),
            outcome: 'rejected',
            errorCode: 'OAuthException',
            errorDetail: 'Error validating access token: the session has expired',
            remoteJobId: null,
            remotePostId: null,
          },
        ],
      },
    );
    this.requestRow(P5.requests.open, P5.revisions.one, 'open');
    this.requestRow(P5.requests.stale, P5.revisions.one, 'stale', 'variant_changed');
    this.requestRow(P5.requests.changes, P5.revisions.changes, 'decided');
    this.decisions.push({
      id: rid('rd'),
      reviewRequestId: P5.requests.changes,
      deciderKind: 'user',
      deciderId: 'usr_reviewer',
      decision: 'request_changes',
      comment: 'Shorten the headline and use the approved lamp photo.',
      manifestHash: this.request(P5.requests.changes).manifestHash,
      verifiedEmail: null,
      createdAt: now(),
    });
    this.requestRow(P5.requests.invalidated, P5.revisions.two, 'decided');
    this.approval(P5.requests.invalidated, 'invalidated', 'content_revision_changed');
    this.requestRow(P5.requests.revoked, P5.revisions.two, 'open');
    this.link(
      'rl_id_revoked',
      P5.requests.revoked,
      P5.links.revoked,
      'former@client.example',
      daysFromNow(5),
      daysFromNow(-1),
    );
    this.link(
      'rl_id_active',
      P5.requests.revoked,
      P5.links.active,
      'approver@client.example',
      daysFromNow(5),
    );
    this.link('rl_id_expired', P5.requests.revoked, P5.links.expired, 'late@client.example', daysFromNow(-2));
    this.requestRow(P5.requests.approved, P5.revisions.three, 'decided');
    this.approval(P5.requests.approved, 'valid');
  }

  /** Mirrors packages/modules/review attentionFor. */
  attentionFor(r: Request): InboxAttention[] {
    const out: InboxAttention[] = [];
    const revision = this.revisions.get(r.contentRevisionId) as Revision;
    const approvals = this.approvals.filter((a) => a.reviewRequestId === r.id);
    const revoked = [...this.links.values()].filter(
      (l) => l.reviewRequestId === r.id && l.revokedAt !== null,
    ).length;
    if (r.state === 'open') out.push('awaiting_decision');
    if (r.state === 'stale') out.push('stale');
    if (r.state === 'decided' && revision.state === 'changes_requested') out.push('changes_requested');
    if (approvals.some((a) => a.state === 'valid')) out.push('approved');
    if (approvals.some((a) => a.state === 'invalidated')) out.push('approval_invalidated');
    if (revoked > 0) out.push('external_access_revoked');
    return out;
  }
}

const withoutAttempts = ({ attempts: _a, ...p }: Publication) => p;
const revisionStateFor = (b: Phase5Backend, r: Request) =>
  (b.revisions.get(r.contentRevisionId) as Revision).state;
const linksFor = (b: Phase5Backend, requestId: string) =>
  [...b.links.values()]
    .filter((l) => l.reviewRequestId === requestId)
    .map((l) => ({
      id: l.id,
      email: l.email,
      expiresAt: l.expiresAt,
      revokedAt: l.revokedAt,
      emailVerifiedAt: l.emailVerifiedAt,
      lastUsedAt: l.lastUsedAt,
    }));

/** Spec 5.5 for an external reviewer: revoked, expired, wrong request, then the resource state (open only). */
function assertReviewer(link: ReviewerLink, request: Request, deciding: boolean) {
  if (link.revokedAt) throw new PolicyDeniedError('reviewer_link_revoked');
  if (new Date(link.expiresAt).getTime() < Date.now()) throw new PolicyDeniedError('reviewer_link_expired');
  if (link.reviewRequestId !== request.id) throw new PolicyDeniedError('reviewer_wrong_request');
  if (deciding && request.state !== 'open') throw new PolicyDeniedError('resource_state');
}

/**
 * Procedure builders come from mock-api.ts (the shared middlewares); this only adds the phase 5 routers. `query`
 * and `mutation` are the tenant-scoped builders, whose context carries `reviewer` when the bearer was an rl_ token.
 */
export interface Phase5Builders {
  router: typeof t.router;
  query: MockBuilders['query'];
  mutation: MockBuilders['mutation'];
}

/** Procedures a later phase adds to the routers phase 5 owns (tRPC routers cannot be merged below the top level). */
export interface Phase5Extensions {
  variants?: Record<string, AnyTRPCProcedure>;
  channels?: Record<string, AnyTRPCProcedure | ReturnType<typeof t.router>>;
}

export function phase5Routers(
  b: Phase5Backend,
  { router, query, mutation }: Phase5Builders,
  extensions: Phase5Extensions = {},
) {
  const brandOf = (brandId: string) => {
    if (brandId !== b.brandId) throw new NotFoundError('Brand', brandId);
  };
  const content = router({
    calendar: router({
      range: query.input(CalendarRange).query(({ input }) => {
        const i = input;
        brandOf(i.brandId);
        const from = new Date(i.from).getTime();
        const to = new Date(i.to).getTime();
        return {
          brandId: i.brandId,
          from: i.from,
          to: i.to,
          campaigns: [],
          packages: b.calendarPackages(from, to),
          publications: [...b.publications.values()]
            .filter((p) => {
              const t = new Date(p.scheduledFor).getTime();
              return t >= from && t <= to;
            })
            .map((p) => ({
              publicationId: p.id,
              contentPackageId: p.contentPackageId,
              contentRevisionId: p.contentRevisionId,
              channelVariantId: p.channelVariantId,
              channelConnectionId: p.channelConnectionId,
              scheduledFor: p.scheduledFor,
              state: p.state,
            })),
        };
      }),
    }),
    variants: router({
      get: query.input(ChannelVariantGet).query(({ input }) => {
        const i = input;
        const v = b.variants.get(i.variantId);
        if (!v) throw new NotFoundError('ChannelVariant', i.variantId);
        return v;
      }),
      ...extensions.variants,
    }),
    revisions: router({
      get: query.input(ContentRevisionGet).query(({ input }) => {
        const i = input;
        const r = b.revisions.get(i.revisionId);
        if (!r) throw new NotFoundError('ContentRevision', i.revisionId);
        return r;
      }),
    }),
  });

  const publishing = router({
    channels: router({
      list: query.input(ChannelList).query(({ input }) => {
        brandOf(input.brandId);
        return [...b.channels.values()];
      }),
      ...extensions.channels,
    }),
    publications: router({
      schedule: mutation.input(ScheduleCommand).mutation(({ ctx, input }) => {
        if (b.failNextSchedule) {
          b.failNextSchedule = false;
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'simulated outage' });
        }
        const cmd = input;
        const v = b.variants.get(cmd.channelVariantId);
        if (!v) throw new NotFoundError('ChannelVariant', cmd.channelVariantId);
        if (!v.validation.ok)
          throw new ValidationFailedError(
            v.validation.issues.map((i) => ({ path: i.path ?? 'variant', issue: i.issue })),
            'The variant does not pass the channel capability check',
          );
        const id = rid('pub');
        const row: Publication = {
          id,
          brandId: v.brandId,
          contentPackageId: v.contentPackageId,
          contentRevisionId: v.contentRevisionId,
          channelVariantId: v.id,
          channelConnectionId: v.channelConnectionId,
          occurrenceKey: cmd.occurrence ?? 'default',
          authority: cmd.authority,
          approvalId: cmd.approvalId ?? null,
          mandateId: cmd.mandateId ?? null,
          scheduledFor: cmd.scheduledFor,
          state: 'scheduled',
          stateReason: null,
          holdReasons: [],
          remotePostId: null,
          remoteUrl: null,
          fencingToken: null,
          claimedAt: null,
          scheduledByKind: 'user',
          scheduledById: ctx.member?.userId ?? 'usr_e2e',
          createdAt: now(),
          updatedAt: now(),
          version: 0,
          attempts: [],
        };
        b.publications.set(id, row);
        return withoutAttempts(row);
      }),
      cancel: mutation.input(CancelCommand).mutation(({ input }) => {
        const cmd = input;
        const p = b.publication(cmd.publicationId);
        if (p.state === 'dispatching' || p.state === 'processing' || p.state === 'outcome_unknown')
          return {
            prevented: false as const,
            state: p.state,
            message: 'Dispatch in progress; outcome will be reconciled',
          };
        if (p.state !== 'scheduled' && p.state !== 'held') throw new PolicyDeniedError('resource_state');
        if (p.version !== cmd.expectedVersion)
          throw new ConflictError('Publication', p.id, cmd.expectedVersion);
        b.transition(p.id, { state: 'cancelled', stateReason: 'user_cancel' });
        return { prevented: true as const, state: 'cancelled' as const, version: p.version };
      }),
      reschedule: mutation.input(RescheduleCommand).mutation(({ input }) => {
        const cmd = input;
        const p = b.publication(cmd.publicationId);
        if (p.version !== cmd.expectedVersion)
          throw new ConflictError('Publication', p.id, cmd.expectedVersion);
        if (p.state !== 'scheduled' && p.state !== 'held' && p.state !== 'retry_eligible')
          throw new ValidationFailedError(
            [{ path: 'publicationId', issue: `reschedule_not_allowed_in_state:${p.state}` }],
            'This publication cannot be rescheduled in its current state',
          );
        b.transition(p.id, {
          state: 'scheduled',
          scheduledFor: cmd.scheduledFor,
          holdReasons: [],
          stateReason: null,
        });
        return withoutAttempts(p);
      }),
      get: query.input(PublicationGet).query(({ input }) => b.publication(input.publicationId)),
      list: query.input(PublicationList).query(({ input }) => {
        const i = input;
        brandOf(i.brandId);
        return {
          items: [...b.publications.values()]
            .filter((p) => !i.state || p.state === i.state)
            .map(withoutAttempts),
          nextCursor: null,
        };
      }),
      evidence: query.input(PublicationEvidence).query(() => []),
      reconcile: mutation.input(ReconcileCommand).mutation(({ input }) => {
        const cmd = input;
        const p = b.publication(cmd.publicationId);
        if (p.state !== 'outcome_unknown' && p.state !== 'held')
          throw new ValidationFailedError(
            [{ path: 'publicationId', issue: `reconcile_not_allowed_in_state:${p.state}` }],
            'Only outcome_unknown or held publications can be reconciled by hand',
          );
        if (cmd.resolution === 'confirm_published') {
          if (!cmd.remotePostId)
            throw new ValidationFailedError([
              { path: 'remotePostId', issue: 'required_for_confirm_published' },
            ]);
          b.transition(p.id, {
            state: p.state === 'outcome_unknown' ? 'published' : p.state,
            remotePostId: cmd.remotePostId,
            remoteUrl: cmd.remoteUrl ?? null,
            stateReason: 'human_confirmed',
          });
        } else if (cmd.resolution === 'confirm_absent') {
          if (p.state !== 'outcome_unknown')
            throw new ValidationFailedError(
              [{ path: 'publicationId', issue: 'illegal transition' }],
              'This change is not allowed in the current state',
            );
          b.transition(p.id, { state: 'retry_eligible', stateReason: 'human_confirmed_absent' });
        } else {
          if (p.state !== 'held')
            throw new ValidationFailedError(
              [{ path: 'publicationId', issue: 'illegal transition' }],
              'This change is not allowed in the current state',
            );
          b.transition(p.id, { state: 'cancelled', stateReason: 'human_cancelled' });
        }
        return withoutAttempts(p);
      }),
      deleteRemote: mutation
        .input(z.object({ publicationId: z.string(), reason: z.string() }))
        .mutation(({ input }) => {
          const p = b.publication(input.publicationId);
          return { accepted: true, publicationId: p.id, remotePostId: p.remotePostId };
        }),
    }),
  });

  const review = router({
    requests: router({
      /** Spec 13.3: freezes the manifest of the revision and its variants; draft | changes_requested → in_review. */
      create: mutation.input(ReviewRequestCreate).mutation(({ ctx, input }) => {
        const revision = b.revisions.get(input.contentRevisionId);
        if (!revision) throw new NotFoundError('ContentRevision', input.contentRevisionId);
        if (revision.state !== 'draft' && revision.state !== 'changes_requested')
          throw new ValidationFailedError(
            [{ path: 'contentRevisionId', issue: `revision is ${revision.state}` }],
            'Only a draft revision can be sent for review',
          );
        if ([...b.requests.values()].some((r) => r.contentRevisionId === revision.id && r.state === 'open'))
          throw new ValidationFailedError([{ path: 'contentRevisionId', issue: 'request_already_open' }]);
        const variants = [...b.variants.values()].filter((v) => v.contentRevisionId === revision.id);
        const frozenManifest = { ...manifestFor(revision, variants), timing: input.timing };
        const id = rid('rr');
        b.requests.set(id, {
          id,
          brandId: revision.brandId,
          contentRevisionId: revision.id,
          frozenManifest,
          manifestHash: hash(frozenManifest),
          assignees: input.assigneeUserIds,
          dueAt: input.dueAt ?? null,
          state: 'open',
          staleReason: null,
          requestedByKind: 'user',
          requestedById: ctx.member?.userId ?? 'usr_e2e',
          createdAt: now(),
          updatedAt: now(),
          version: 0,
        });
        Object.assign(revision, { state: 'in_review', updatedAt: now(), version: revision.version + 1 });
        b.packageStateChanged(revision.contentPackageId, 'in_review');
        return {
          reviewRequestId: id,
          manifestHash: hash(frozenManifest),
          revisionState: 'in_review' as const,
          state: 'open' as const,
          version: 0,
        };
      }),
      get: query.input(ReviewRequestGet).query(({ ctx, input }) => {
        const r = b.request(input.reviewRequestId);
        if (ctx.reviewer) {
          assertReviewer(ctx.reviewer, r, false);
          ctx.reviewer.lastUsedAt = now();
          ctx.reviewer.emailVerifiedAt ??= now();
          return {
            id: r.id,
            state: r.state,
            staleReason: r.staleReason,
            frozenManifest: r.frozenManifest,
            manifestHash: r.manifestHash,
            dueAt: r.dueAt,
            createdAt: r.createdAt,
          };
        }
        return {
          ...r,
          revisionState: revisionStateFor(b, r),
          decisions: b.decisions.filter((d) => d.reviewRequestId === r.id),
          approvals: b.approvals.filter((a) => a.reviewRequestId === r.id),
          externalLinks: linksFor(b, r.id),
        };
      }),
    }),
    decisions: router({
      submit: mutation.input(ReviewDecisionSubmit).mutation(({ ctx, input }) => {
        const i = input;
        const r = b.request(i.reviewRequestId);
        if (ctx.reviewer) assertReviewer(ctx.reviewer, r, true);
        else if (r.state !== 'open') throw new PolicyDeniedError('resource_state');
        if (i.expectedManifestHash !== r.manifestHash)
          throw new ValidationFailedError(
            [{ path: 'expectedManifestHash', issue: 'manifest_hash_mismatch' }],
            'You decided on a different manifest; reload the request',
          );
        if (i.decision === 'reject' && !i.comment?.trim())
          throw new ValidationFailedError(
            [{ path: 'comment', issue: 'reason_required' }],
            'A rejection needs a reason',
          );
        const revision = b.revisions.get(r.contentRevisionId) as Revision;
        const decisionId = rid('rd');
        b.decisions.push({
          id: decisionId,
          reviewRequestId: r.id,
          deciderKind: ctx.reviewer ? 'external_reviewer' : 'user',
          deciderId: ctx.reviewer ? ctx.reviewer.id : (ctx.member?.userId ?? 'usr_e2e'),
          decision: i.decision,
          comment: i.comment ?? null,
          manifestHash: r.manifestHash,
          verifiedEmail: ctx.reviewer ? ctx.reviewer.email : null,
          createdAt: now(),
        });
        let approvalId: string | null = null;
        if (i.decision === 'approve') {
          approvalId = rid('apr');
          b.approvals.push({
            id: approvalId,
            brandId: r.brandId,
            contentRevisionId: r.contentRevisionId,
            reviewRequestId: r.id,
            approverKind: ctx.reviewer ? 'external_reviewer' : 'user',
            approverId: ctx.reviewer ? ctx.reviewer.id : (ctx.member?.userId ?? 'usr_e2e'),
            bindingHash: hash(r.manifestHash),
            binding: { v: 1 },
            validUntil: i.validUntil ?? null,
            state: 'valid',
            invalidatedReason: null,
            createdAt: now(),
            version: 1,
          });
          revision.state = 'approved';
          b.packageStateChanged(revision.contentPackageId, 'approved');
        } else {
          revision.state = 'changes_requested';
          b.packageStateChanged(revision.contentPackageId, 'draft');
        }
        r.state = 'decided';
        r.version += 1;
        return {
          decisionId,
          decision: i.decision,
          approvalId,
          requestState: r.state,
          revisionState: revision.state,
        };
      }),
    }),
    inbox: router({
      list: query.input(ReviewInboxList).query(({ input }) => {
        const i = input;
        if (i.brandId) brandOf(i.brandId);
        return {
          items: [...b.requests.values()].map((r) => ({
            ...r,
            revisionState: revisionStateFor(b, r),
            contentPackageId: (b.revisions.get(r.contentRevisionId) as Revision).contentPackageId,
            approvals: b.approvals.filter((a) => a.reviewRequestId === r.id),
            externalLinks: {
              total: linksFor(b, r.id).length,
              revoked: linksFor(b, r.id).filter((l) => l.revokedAt !== null).length,
            },
            attention: b.attentionFor(r),
          })),
          nextCursor: null,
        };
      }),
    }),
    externalLinks: router({
      create: mutation.input(ExternalLinkCreate).mutation(({ input }) => {
        const i = input;
        const r = b.request(i.reviewRequestId);
        if (r.state !== 'open')
          throw new ValidationFailedError([{ path: 'reviewRequestId', issue: 'request_not_open' }]);
        if (new Date(i.expiresAt).getTime() <= Date.now())
          throw new ValidationFailedError([{ path: 'expiresAt', issue: 'must be in the future' }]);
        const linkId = rid('rlid');
        const token = `rl_${randomUUID().replace(/-/g, '')}`;
        b.links.set(linkId, {
          id: linkId,
          reviewRequestId: r.id,
          brandId: r.brandId,
          email: i.email,
          token,
          expiresAt: i.expiresAt,
          revokedAt: null,
          emailVerifiedAt: null,
          lastUsedAt: null,
        });
        return { linkId, token, reviewRequestId: r.id, expiresAt: i.expiresAt };
      }),
      revoke: mutation.input(ExternalLinkRevoke).mutation(({ input }) => {
        const i = input;
        const l = b.links.get(i.linkId);
        if (!l) throw new NotFoundError('ExternalReviewerLink', i.linkId);
        l.revokedAt = now();
        return { linkId: l.id, revoked: true as const };
      }),
    }),
    approvals: router({
      get: query.input(ApprovalGet).query(({ input }) => {
        const a = b.approvals.find((x) => x.id === input.approvalId);
        if (!a) throw new NotFoundError('ReleaseApproval', input.approvalId);
        return a;
      }),
    }),
  });

  return { content, publishing, review };
}
