import { z } from 'zod';

export const PublicationState = z.enum([
  'scheduled',
  'dispatching',
  'processing',
  'published',
  'failed',
  'outcome_unknown',
  'retry_eligible',
  'cancelled',
  'held',
]);
export type PublicationState = z.infer<typeof PublicationState>;

export const PublicationAuthority = z.enum(['approval', 'mandate']);
export type PublicationAuthority = z.infer<typeof PublicationAuthority>;

export const AttemptOutcome = z.enum(['accepted', 'pending', 'rejected', 'retryable_error', 'unknown']);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

/** Spec 14.1: the scheduling command. */
export const ScheduleCommand = z.object({
  channelVariantId: z.string(),
  scheduledFor: z.string().datetime(),
  authority: PublicationAuthority,
  approvalId: z.string().optional(),
  mandateId: z.string().optional(),
  occurrence: z.string().max(40).optional(), // deliberate repeats get a new occurrence value
});
export type ScheduleCommand = z.infer<typeof ScheduleCommand>;

export const CancelCommand = z.object({ publicationId: z.string(), expectedVersion: z.number().int() });
export const RescheduleCommand = z.object({
  publicationId: z.string(),
  expectedVersion: z.number().int(),
  scheduledFor: z.string().datetime(),
});
export const ReconcileCommand = z.object({
  publicationId: z.string(),
  resolution: z.enum(['confirm_published', 'confirm_absent', 'cancel']),
  remotePostId: z.string().optional(),
  remoteUrl: z.string().optional(),
  note: z.string().max(500).optional(),
});

export interface AttemptResult {
  attemptId: string;
  outcome: AttemptOutcome;
  remotePostId?: string;
  remoteUrl?: string;
  remoteJobId?: string;
  pending?: unknown;
  errorCode?: string;
  errorDetail?: string;
  retryAfterMs?: number;
  error?: string;
}

export const ChannelConnectStart = z.object({
  brandId: z.string(),
  providerKey: z.string(),
  redirectUri: z.string().url(),
});
export const ChannelConnectComplete = z.object({ state: z.string(), code: z.string() });

export const MandateSourceRules = z.object({
  onlyApprovedFacts: z.boolean().default(true),
  onlyApprovedTemplates: z.boolean().default(true),
  onlyApprovedAssets: z.boolean().default(true),
  requireBrandReviewClean: z.boolean().default(true),
});
export type MandateSourceRules = z.infer<typeof MandateSourceRules>;

export const MandateState = z.enum(['active', 'paused', 'revoked', 'expired']);
export const MandateCreate = z.object({
  brandId: z.string(),
  servicePrincipalId: z.string(),
  channelConnectionIds: z.array(z.string()).min(1).max(50),
  allowedContentClasses: z.array(z.string()).min(1).max(50),
  sourceRules: MandateSourceRules,
  maxPostsPerDay: z.number().int().min(1).max(100),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(), // mandates always expire
});

// ---------------------------------------------------------------------------------------------------------------
// Phase 5 publishing (spec 13.5, 14.1, 14.3, 14.7): router DTOs, workflow inputs, activity contracts and the
// cross-module hook shapes. Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';
import type { ActivityHooks } from './agents';
import type { ChannelConnectionStatus, PendingCheck, ReconcileResult } from './providers';

// ---- router DTOs (spec 7.5 publishing router) ----
export const ChannelList = z.object({ brandId: z.string() });
export const ChannelDisconnect = z.object({
  channelConnectionId: z.string(),
  expectedVersion: z.number().int(),
});
export const PublicationGet = z.object({ publicationId: z.string() });
export const PublicationList = z.object({
  brandId: z.string(),
  state: PublicationState.optional(),
  page: PageRequest,
});
export const PublicationEvidence = z.object({ publicationId: z.string() });
export const PublicationDeleteRemote = z.object({ publicationId: z.string(), reason: z.string().max(500) });

/** Spec 13.5: the cancel response; `prevented: false` means dispatch already started and the outcome is reconciled. */
export type CancelResult =
  | { prevented: true; state: PublicationState; version: number }
  | { prevented: false; state: PublicationState; message: string };

/**
 * The publication as the release evaluator (spec 13.4, review module) sees it: references only. `id` is
 * 'preview' for the fail-fast pre-check at scheduling time (spec 14.1 previewPublication).
 */
export interface PublicationForRelease {
  id: string;
  tenantId: string;
  brandId: string;
  contentPackageId: string;
  contentRevisionId: string;
  channelVariantId: string;
  channelConnectionId: string;
  authority: PublicationAuthority;
  approvalId: string | null;
  mandateId: string | null;
  scheduledFor: string;
  state: PublicationState;
}

/** What the publishing module needs from a channel variant (content module `contentService.variants.get`). */
export interface ChannelVariantForPublishing {
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
  version: number;
}

// ---- workflow contract (publicationWorkflowV1 on task queue `core`, workflow id `pub:<publicationId>`) ----

/** Workflow input: references only (spec 14.7 R5). Activities re-load the row and the actor's grants (spec 5.2). */
export const PublicationWorkflowInputV1 = TenantContextInput.extend({ publicationId: z.string() });
export type PublicationWorkflowInputV1 = z.infer<typeof PublicationWorkflowInputV1>;

/** Signals relayed from the outbox to a running publication workflow (publicationSignalRelayV1). */
export const PublicationSignalV1 = z.discriminatedUnion('signal', [
  z.object({ workflowId: z.string(), signal: z.literal('cancel') }),
  z.object({ workflowId: z.string(), signal: z.literal('reschedule') }),
]);
export type PublicationSignalV1 = z.infer<typeof PublicationSignalV1>;

/** Reconciliation started on its own (sweeper-detected worker loss) runs the same loop as the publication workflow. */
export const PublicationReconcileInputV1 = PublicationWorkflowInputV1.extend({
  attemptId: z.string().nullable(),
  /** Chooses the `publish-<providerKey>` lookup queue; a key, never a connection object (R5). */
  providerKey: z.string(),
});
export type PublicationReconcileInputV1 = z.infer<typeof PublicationReconcileInputV1>;

export const TokenRefreshWorkflowInputV1 = TenantContextInput.extend({ channelConnectionId: z.string() });
export type TokenRefreshWorkflowInputV1 = z.infer<typeof TokenRefreshWorkflowInputV1>;

/** The sweeper is platform-level (it spans tenants, like the outbox dispatcher); it carries no tenant. */
export const PublicationSweepInputV1 = z.object({
  correlationId: z.string(),
  now: z.string().datetime(),
  /** A `dispatching` claim older than this with no running workflow is worker loss → outcome_unknown. */
  claimLeaseSeconds: z.number().int().positive(),
  /** A `scheduled` row this far past due with no running workflow gets its start event re-emitted. */
  graceSeconds: z.number().int().nonnegative(),
});
export type PublicationSweepInputV1 = z.infer<typeof PublicationSweepInputV1>;

export interface ReadScheduleResultV1 {
  state: PublicationState;
  scheduledFor: string;
  version: number;
}
export type ClaimInputV1 = PublicationWorkflowInputV1 & { claimant: string };
export type ClaimResultV1 =
  | { ok: true; fencingToken: number; providerKey: string; channelConnectionId: string }
  | { ok: false; state: PublicationState };
export type FencedInputV1 = PublicationWorkflowInputV1 & { fencingToken: number };
export type ReleaseEvaluationResultV1 = { allow: true } | { allow: false; reasons: string[] };
export type HoldInputV1 = PublicationWorkflowInputV1 & { reasons: string[] };
export type AttemptInputV1 = PublicationWorkflowInputV1 & { attempt: AttemptResult };
export type ReconcileFound = Extract<ReconcileResult, { status: 'found' }>;
export type MarkPublishedInputV1 = PublicationWorkflowInputV1 & {
  attempt?: AttemptResult;
  evidence?: ReconcileFound & { attemptId: string | null };
};
export type OutcomeUnknownInputV1 = PublicationWorkflowInputV1 & { attemptId: string | null };
export type HoldForHumanInputV1 = PublicationWorkflowInputV1 & { reason: string };
export type RetryResultV1 =
  { retried: true; scheduledFor: string } | { retried: false; reason: 'sent' | 'state' };
/** Every control activity is idempotent: a repeat reports `changed: false` and the state it found. */
export interface TransitionResultV1 {
  state: PublicationState;
  version: number;
  changed: boolean;
}

/** Spec 14.3 `PublishControlActivities` (task queue `core`; every activity idempotent). */
export interface PublishControlActivitiesV1 {
  readSchedule(input: PublicationWorkflowInputV1): Promise<ReadScheduleResultV1>;
  cancelIfNotStarted(input: PublicationWorkflowInputV1): Promise<TransitionResultV1>;
  claimForDispatch(input: ClaimInputV1): Promise<ClaimResultV1>;
  evaluateRelease(input: FencedInputV1): Promise<ReleaseEvaluationResultV1>;
  hold(input: HoldInputV1): Promise<TransitionResultV1>;
  releaseClaimAndCancel(input: FencedInputV1): Promise<TransitionResultV1>;
  /** Commits the publication_attempts row BEFORE any outbound call; idempotent on (publicationId, fencingToken). */
  openAttempt(input: FencedInputV1): Promise<string>;
  markProcessing(input: AttemptInputV1): Promise<TransitionResultV1>;
  markPublished(input: MarkPublishedInputV1): Promise<TransitionResultV1>;
  markFailed(input: AttemptInputV1): Promise<TransitionResultV1>;
  markOutcomeUnknown(input: OutcomeUnknownInputV1): Promise<TransitionResultV1>;
  markRetryEligible(input: PublicationWorkflowInputV1): Promise<TransitionResultV1>;
  holdForHuman(input: HoldForHumanInputV1): Promise<TransitionResultV1>;
  /** Back to `scheduled` with backoff only when the attempt has no sentAt; with sentAt the outcome is unknown. */
  retryAfterProvenNoEffect(input: AttemptInputV1): Promise<RetryResultV1>;
}

export type PublishOnceInputV1 = FencedInputV1 & { attemptId: string };
export type FindRemotePostInputV1 = PublicationWorkflowInputV1 & { attemptId: string | null };

/** Spec 14.3 `ProviderActivities` + `ReconcileActivities` (task queue `publish-<providerKey>`). */
export interface PublishProviderActivitiesV1 {
  /** retry.maximumAttempts: 1 in the workflow; never retries a mutation after send. */
  publishOnce(input: PublishOnceInputV1): Promise<AttemptResult>;
  /** Read-only. */
  checkStatus(input: PublishOnceInputV1): Promise<PendingCheck>;
  /** Once finalisation went through, checkStatus reports completed (spec 20.3); a repeat never duplicates. */
  finalize(input: PublishOnceInputV1): Promise<PendingCheck>;
  /** Read-only, safe to retry. */
  findRemotePost(input: FindRemotePostInputV1): Promise<ReconcileResult>;
}

export interface RefreshScheduleResultV1 {
  status: ChannelConnectionStatus;
  tokenExpiresAt: string | null;
}
export type RefreshCredentialsResultV1 =
  | { ok: true; tokenExpiresAt: string | null }
  | { ok: false; reason: 'locked' | 'transient' | 'reconnect_required' | 'not_active' };

/** Spec 14.7 tokenRefreshWorkflowV1 activities (task queue `core`). */
export interface TokenRefreshActivitiesV1 {
  readRefreshSchedule(input: TokenRefreshWorkflowInputV1): Promise<RefreshScheduleResultV1>;
  refreshCredentials(input: TokenRefreshWorkflowInputV1): Promise<RefreshCredentialsResultV1>;
}

export interface SweepResultV1 {
  scheduledReemitted: number;
  dispatchingExpired: number;
}
export interface PublicationSweepActivitiesV1 {
  sweepPublications(input: PublicationSweepInputV1): Promise<SweepResultV1>;
}

/** The module-side implementations the activities wrap (tenant context is established by the activity host). */
export type PublishControlRuntimeV1 = PublishControlActivitiesV1;
export interface PublishProviderRuntimeV1 {
  publishOnce(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<AttemptResult>;
  checkStatus(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<PendingCheck>;
  finalize(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<PendingCheck>;
  findRemotePost(input: FindRemotePostInputV1, hooks?: ActivityHooks): Promise<ReconcileResult>;
}
export type TokenRefreshRuntimeV1 = TokenRefreshActivitiesV1;
export type PublicationSweepRuntimeV1 = PublicationSweepActivitiesV1;
