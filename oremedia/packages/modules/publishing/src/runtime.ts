import type { ActivityHooks } from '@oremedia/contracts/agents';
import {
  NotFoundError,
  PolicyDeniedError,
  ReleaseIntegrityError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import {
  PendingState,
  type PendingCheck,
  type PublishOutcome,
  type ReconcileResult,
} from '@oremedia/contracts/providers';
import type {
  AttemptInputV1,
  AttemptResult,
  ClaimInputV1,
  ClaimResultV1,
  FencedInputV1,
  FindRemotePostInputV1,
  HoldForHumanInputV1,
  HoldInputV1,
  MarkPublishedInputV1,
  OutcomeUnknownInputV1,
  PublicationSweepInputV1,
  PublicationWorkflowInputV1,
  PublishControlRuntimeV1,
  PublishOnceInputV1,
  PublishProviderRuntimeV1,
  PublicationSweepRuntimeV1,
  ReadScheduleResultV1,
  RefreshCredentialsResultV1,
  ReleaseEvaluationResultV1,
  RetryResultV1,
  SweepResultV1,
  TokenRefreshRuntimeV1,
  TokenRefreshWorkflowInputV1,
  TransitionResultV1,
} from '@oremedia/contracts/publishing';
import { requireTenant, runAsPlatform, runInTenant, withTransaction, type Tx } from '@oremedia/db';
import { hashCanonical, hashText } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { PublicationEvent } from '@oremedia/domain/state-machines/publication';
import { MemoryRateLimiterStore, audit, outbox, type RateLimiterStore } from '@oremedia/module-operations';
import { METRIC, count, logger, record } from '@oremedia/observability';
import {
  ProviderRateLimitWaitExceeded,
  ProviderTransportError,
  outcomeFromClass,
  truncateForTemporal,
  type ProviderIO,
  type PublishRequest,
} from '@oremedia/providers';
import { credentialBroker } from './broker';
import {
  forRelease,
  reconcileWorkflowId,
  transition,
  workflowIdOf,
  type AttemptRow,
  type PublicationRow,
} from './common';
import { approvals, providerClientFor, publishMedia, review, variants, workflowRunning } from './hooks';
import { adapterFor, providerIO, registry } from './providers';
import {
  ChannelConnectionRepository,
  CredentialRefRepository,
  PublicationAttemptRepository,
  PublicationRepository,
  PublicationSweepRepository,
  RemoteEvidenceRepository,
} from './repositories';

export interface PublishingRuntimeOptions {
  now?: () => Date;
  /** Per-connection refresh lock (Redis-backed in production; memory fallback). */
  refreshLock?: RateLimiterStore;
  /** Pre-send retries beyond this many attempts hold the publication for a person (spec 14.3 backoff has an end). */
  maxPreSendAttempts?: number;
}

export interface PublishingRuntime {
  control: PublishControlRuntimeV1;
  provider: PublishProviderRuntimeV1;
  tokenRefresh: TokenRefreshRuntimeV1;
  sweep: PublicationSweepRuntimeV1;
}

const publicationsRepo = new PublicationRepository();
const attemptsRepo = new PublicationAttemptRepository();
const evidenceRepo = new RemoteEvidenceRepository();
const connectionsRepo = new ChannelConnectionRepository();
const credentialsRepo = new CredentialRefRepository();
const sweepRepo = new PublicationSweepRepository();

/** The actor the workflow carries; every write is audited as that actor (spec 5.2 re-resolved by the host). */
const workflowActor = () => requireTenant().actor;

const MAX_PRE_SEND_ATTEMPTS = 8;
const REFRESH_LOCK_SECONDS = 60;
/** Hold reason when an export's bytes no longer hash to what the approval pinned (spec 3.g4). */
export const EXPORT_HASH_MISMATCH = 'export_hash_mismatch';

/** 30 s · 2^(n-1) capped at 30 minutes, never below the provider's Retry-After (spec 14.3 backoff). */
export function preSendBackoffMs(attemptNumber: number, retryAfterMs?: number): number {
  const base = Math.min(30_000 * 2 ** Math.max(0, attemptNumber - 1), 30 * 60_000);
  return Math.max(base, retryAfterMs ?? 0);
}

function assertFence(row: PublicationRow, fencingToken: number): void {
  if (row.fencingToken !== fencingToken)
    throw new ValidationFailedError(
      [{ path: 'fencingToken', issue: `stale_fencing_token:${fencingToken}!=${row.fencingToken}` }],
      'This attempt no longer holds the publication',
    );
}

async function loadAttempt(row: PublicationRow, attemptId: string, tx?: Tx): Promise<AttemptRow> {
  const attempt = await attemptsRepo.getById(attemptId, tx);
  if (attempt.publicationId !== row.id) throw new NotFoundError('PublicationAttempt', attemptId);
  return attempt;
}

const unchanged = (row: PublicationRow): TransitionResultV1 => ({
  state: row.state,
  version: row.version,
  changed: false,
});

/** One state move: machine transition, row update, audit and state_changed event, in the caller's transaction. */
async function move(
  row: PublicationRow,
  event: PublicationEvent,
  values: Partial<Parameters<PublicationRepository['update']>[2]>,
  action: string,
  reason: string | null,
  tx: Tx,
): Promise<TransitionResultV1> {
  const toState = transition(row.state, event, 'publicationId');
  await publicationsRepo.update(row.id, row.version, { ...values, state: toState }, tx);
  await audit.record(workflowActor(), action, { type: 'publication', id: row.id }, 'allowed', tx, {
    brandId: row.brandId,
    publicationId: row.id,
    fromState: row.state,
    toState,
    reason,
  });
  await outbox.add(
    'publication.state_changed',
    { type: 'publication', id: row.id, version: row.version + 1 },
    { publicationId: row.id, fromState: row.state, toState, reason },
    tx,
    { brandId: row.brandId },
  );
  return { state: toState, version: row.version + 1, changed: true };
}

const attemptResultOf = (a: AttemptRow): AttemptResult => ({
  attemptId: a.id,
  outcome: a.outcome,
  ...(a.remotePostId ? { remotePostId: a.remotePostId } : {}),
  ...(a.remoteJobId ? { remoteJobId: a.remoteJobId } : {}),
  ...(a.pendingState ? { pending: PendingState.parse(a.pendingState) } : {}),
  ...(a.errorCode ? { errorCode: a.errorCode } : {}),
  ...(a.errorDetail ? { errorDetail: a.errorDetail } : {}),
});

/** Converts the adapter's classified outcome into the attempt ledger's columns and the workflow's result. */
function fromOutcome(attemptId: string, outcome: PublishOutcome): AttemptResult {
  switch (outcome.outcome) {
    case 'accepted':
      return {
        attemptId,
        outcome: 'accepted',
        remotePostId: outcome.remotePostId,
        remoteUrl: outcome.remoteUrl,
      };
    case 'pending':
      return {
        attemptId,
        outcome: 'pending',
        pending: outcome.pending,
        ...(outcome.remoteJobId ? { remoteJobId: outcome.remoteJobId } : {}),
      };
    case 'rejected':
      return {
        attemptId,
        outcome: 'rejected',
        errorCode: outcome.code,
        errorDetail: truncateForTemporal(outcome.message),
      };
    case 'retryable_error':
      return {
        attemptId,
        outcome: 'retryable_error',
        errorCode: outcome.code,
        errorDetail: truncateForTemporal(outcome.message),
        ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
      };
    case 'unknown':
      return {
        attemptId,
        outcome: 'unknown',
        errorCode: outcome.code,
        errorDetail: truncateForTemporal(outcome.message),
      };
  }
}

export function createPublishingRuntime(opts: PublishingRuntimeOptions = {}): PublishingRuntime {
  const now = opts.now ?? (() => new Date());
  const refreshLock = opts.refreshLock ?? new MemoryRateLimiterStore();
  const maxPreSend = opts.maxPreSendAttempts ?? MAX_PRE_SEND_ATTEMPTS;
  const log = logger().child('publishing');

  const recordAttemptOutcome = (attemptId: string, result: AttemptResult, tx: Tx) =>
    attemptsRepo.recordOutcome(
      attemptId,
      {
        outcome: result.outcome,
        errorCode: result.errorCode ?? null,
        errorDetail: result.errorDetail ? result.errorDetail.slice(0, 2000) : null,
        remoteJobId: result.remoteJobId ?? null,
        remotePostId: result.remotePostId ?? null,
        pendingState: (result.pending as Record<string, unknown> | undefined) ?? null,
      },
      now(),
      tx,
    );

  const control: PublishControlRuntimeV1 = {
    async readSchedule({ publicationId }: PublicationWorkflowInputV1): Promise<ReadScheduleResultV1> {
      const row = await publicationsRepo.getById(publicationId);
      return { state: row.state, scheduledFor: row.scheduledFor.toISOString(), version: row.version };
    },

    cancelIfNotStarted: ({ publicationId }) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state !== 'scheduled') return unchanged(row);
        return move(
          row,
          'user_cancel',
          { stateReason: 'user_cancel' },
          'publication.cancel',
          'cancel_signal',
          tx,
        );
      }),

    /** scheduled → dispatching with a fencing token; the same claimant asking again gets the same claim back. */
    claimForDispatch: ({ publicationId, claimant }: ClaimInputV1): Promise<ClaimResultV1> =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        const connection = await connectionsRepo.getById(row.channelConnectionId, tx);
        if (row.state === 'dispatching' && row.claimant === claimant)
          return {
            ok: true,
            fencingToken: row.fencingToken,
            providerKey: connection.providerKey,
            channelConnectionId: connection.id,
          };
        if (row.state !== 'scheduled') return { ok: false, state: row.state };
        const fencingToken = row.fencingToken + 1;
        const at = now();
        await move(
          row,
          'claim',
          { fencingToken, claimant, claimedAt: at, stateReason: null },
          'publication.claim',
          claimant,
          tx,
        );
        record(METRIC.dispatchLatenessMs, Math.max(0, at.getTime() - row.scheduledFor.getTime()), {
          providerKey: connection.providerKey,
        });
        return {
          ok: true,
          fencingToken,
          providerKey: connection.providerKey,
          channelConnectionId: connection.id,
        };
      }),

    /** Spec 13.4 at dispatch, from the live rows; the decision is recorded as an audit event either way. */
    evaluateRelease: ({ publicationId, fencingToken }: FencedInputV1): Promise<ReleaseEvaluationResultV1> =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.getById(publicationId, tx);
        assertFence(row, fencingToken);
        const at = now();
        const decision = await review.evaluateRelease(forRelease(row), at, tx);
        await audit.record(
          workflowActor(),
          'publication.release_check',
          { type: 'publication', id: row.id },
          decision.allow ? 'allowed' : 'denied',
          tx,
          {
            brandId: row.brandId,
            publicationId: row.id,
            reason: decision.allow ? 'allow' : decision.reasons.join(','),
          },
        );
        return decision.allow ? { allow: true } : { allow: false, reasons: decision.reasons };
      }),

    hold: ({ publicationId, reasons }: HoldInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'held') return unchanged(row);
        count(METRIC.publicationOutcomes, 1, { outcome: 'held' });
        return move(
          row,
          'release_policy_failed',
          { holdReasons: reasons, stateReason: 'release_policy_failed' },
          'publication.hold',
          reasons.join(','),
          tx,
        );
      }),

    /** The claim is released (dispatching → scheduled: nothing was sent) and the row cancelled, both by the machine. */
    releaseClaimAndCancel: ({ publicationId, fencingToken }: FencedInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'cancelled') return unchanged(row);
        assertFence(row, fencingToken);
        if (await attemptsRepo.findByFence(row.id, fencingToken, tx))
          throw new ValidationFailedError([{ path: 'publicationId', issue: 'attempt_already_open' }]);
        await move(
          row,
          'retryable_pre_send',
          { claimedAt: null, claimant: workflowIdOf(row) },
          'publication.release_claim',
          'cancel_signal',
          tx,
        );
        const released = await publicationsRepo.lock(publicationId, tx);
        return move(
          released,
          'user_cancel',
          { stateReason: 'user_cancel' },
          'publication.cancel',
          'cancel_signal',
          tx,
        );
      }),

    /** The attempt row commits BEFORE any outbound call; a repeat for the same fence returns the same id. */
    openAttempt: ({ publicationId, fencingToken }: FencedInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        assertFence(row, fencingToken);
        const existing = await attemptsRepo.findByFence(row.id, fencingToken, tx);
        if (existing) return existing.id;
        if (row.state !== 'dispatching')
          throw new ValidationFailedError([
            { path: 'publicationId', issue: `open_attempt_in_state:${row.state}` },
          ]);
        const variant = await variants.get(row.channelVariantId, tx);
        const connection = await connectionsRepo.getById(row.channelConnectionId, tx);
        const cap = registry().capability(connection.providerKey);
        const id = newId('publicationAttempt');
        await attemptsRepo.create(
          {
            id,
            publicationId: row.id,
            attemptNumber: (await attemptsRepo.countForPublication(row.id, tx)) + 1,
            fencingToken,
            requestFingerprint: hashCanonical({
              text: hashText(variant.text),
              altTexts: variant.altTexts,
              settings: variant.settings,
              exportHashes: variant.exportHashes,
            }),
            providerIdempotencyKey: cap?.idempotencyKeySupported ? id : null,
            startedAt: now(),
            outcome: 'unknown', // open: no outcome recorded until finishedAt is set
          },
          tx,
        );
        return id;
      }),

    markProcessing: ({ publicationId, attempt }: AttemptInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'processing') return unchanged(row);
        return move(
          row,
          'provider_pending',
          { stateReason: 'provider_pending' },
          'publication.processing',
          attempt.remoteJobId ?? null,
          tx,
        );
      }),

    /** dispatching/processing/outcome_unknown → published with an evidence row; a repeat changes nothing. */
    markPublished: ({ publicationId, attempt, evidence }: MarkPublishedInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'published') return unchanged(row);
        const remotePostId = evidence?.remotePostId ?? attempt?.remotePostId ?? null;
        const remoteUrl = evidence?.remoteUrl ?? attempt?.remoteUrl ?? null;
        if (!remotePostId)
          throw new ValidationFailedError([{ path: 'attempt', issue: 'remote_post_id_required' }]);
        const attemptId = evidence ? evidence.attemptId : (attempt?.attemptId ?? null);
        const event: PublicationEvent =
          row.state === 'dispatching'
            ? 'provider_accepted'
            : row.state === 'processing'
              ? 'poll_published'
              : 'reconcile_found';
        const kind = evidence
          ? 'reconciliation'
          : row.state === 'processing'
            ? 'status_poll'
            : 'accepted_response';
        const result = await move(
          row,
          event,
          { remotePostId, remoteUrl, stateReason: kind },
          'publication.published',
          kind,
          tx,
        );
        if (!(await evidenceRepo.exists(row.id, attemptId, kind, tx))) {
          const payload = {
            remotePostId,
            remoteUrl,
            attemptId,
            ...(evidence ? { matchedBy: evidence.matchedBy } : {}),
          };
          await evidenceRepo.create(
            {
              id: newId('remoteEvidence'),
              publicationId: row.id,
              attemptId,
              kind,
              remotePostId,
              remoteUrl,
              payload,
              payloadHash: hashCanonical(payload),
              capturedAt: now(),
            },
            tx,
          );
        }
        if (attemptId) await attemptsRepo.attachRemotePost(attemptId, remotePostId, tx);
        // Spec 13.1: the release approval is spent with the publication, in the same transaction.
        if (row.authority === 'approval' && row.approvalId)
          await approvals.consume(
            row.approvalId,
            row.id,
            Array.from(
              new Set([
                ...(await publicationsRepo.listPublishedChannelsForApproval(row.approvalId, tx)),
                row.channelConnectionId,
              ]),
            ),
            tx,
          );
        // Spec 15.1: measurement collection starts from the publication moment (worker-ingest, its own queue).
        const actor = workflowActor();
        await outbox.add(
          'measurement.collection_due',
          { type: 'publication', id: row.id, version: row.version + 1 },
          {
            publicationId: row.id,
            channelConnectionId: row.channelConnectionId,
            actorKind: actor.kind,
            actorId: actor.id,
          },
          tx,
          { brandId: row.brandId },
        );
        count(METRIC.publicationOutcomes, 1, { outcome: 'published' });
        return result;
      }),

    markFailed: ({ publicationId, attempt }: AttemptInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'failed') return unchanged(row);
        // publishOnce already held the row (export_hash_mismatch): a person resolves it; nothing to fail.
        if (row.state === 'held') return unchanged(row);
        const event: PublicationEvent = row.state === 'processing' ? 'poll_failed' : 'provider_rejected';
        count(METRIC.publicationOutcomes, 1, { outcome: 'failed' });
        return move(
          row,
          event,
          { stateReason: (attempt.errorCode ?? 'rejected').slice(0, 120) },
          'publication.failed',
          attempt.errorCode ?? null,
          tx,
        );
      }),

    markOutcomeUnknown: ({ publicationId, attemptId }: OutcomeUnknownInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (attemptId) {
          const attempt = await loadAttempt(row, attemptId, tx);
          if (!attempt.finishedAt)
            await recordAttemptOutcome(
              attempt.id,
              { attemptId, outcome: 'unknown', errorCode: 'ambiguous' },
              tx,
            );
        }
        if (row.state === 'outcome_unknown') return unchanged(row);
        const event: PublicationEvent = row.state === 'processing' ? 'poll_unknown' : 'ambiguous_failure';
        count(METRIC.outcomeUnknownCount, 1);
        count(METRIC.publicationOutcomes, 1, { outcome: 'outcome_unknown' });
        return move(
          row,
          event,
          { stateReason: 'outcome_unknown' },
          'publication.outcome_unknown',
          attemptId,
          tx,
        );
      }),

    markRetryEligible: ({ publicationId }) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'retry_eligible') return unchanged(row);
        count(METRIC.publicationOutcomes, 1, { outcome: 'retry_eligible' });
        return move(
          row,
          'reconcile_absent',
          { stateReason: 'reconcile_absent' },
          'publication.retry_eligible',
          'definitely_absent',
          tx,
        );
      }),

    holdForHuman: ({ publicationId, reason }: HoldForHumanInputV1) =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        if (row.state === 'held') return unchanged(row);
        count(METRIC.publicationOutcomes, 1, { outcome: 'held' });
        return move(
          row,
          'reconcile_exhausted',
          { holdReasons: [reason], stateReason: reason.slice(0, 120) },
          'publication.hold',
          reason,
          tx,
        );
      }),

    /** Only an attempt with NO sentAt proves the call was never made (spec 14.3); with sentAt the outcome is unknown. */
    retryAfterProvenNoEffect: ({ publicationId, attempt }: AttemptInputV1): Promise<RetryResultV1> =>
      withTransaction(async (tx) => {
        const row = await publicationsRepo.lock(publicationId, tx);
        const attemptRow = await loadAttempt(row, attempt.attemptId, tx);
        if (attemptRow.sentAt) return { retried: false, reason: 'sent' };
        if (row.state === 'scheduled' && row.fencingToken === attemptRow.fencingToken)
          return { retried: true, scheduledFor: row.scheduledFor.toISOString() }; // repeat of a committed retry
        if (row.state !== 'dispatching') return { retried: false, reason: 'state' };
        if (attemptRow.attemptNumber >= maxPreSend) {
          await move(
            row,
            'release_policy_failed',
            { holdReasons: ['retry_budget_exhausted'], stateReason: 'retry_budget_exhausted' },
            'publication.hold',
            'retry_budget_exhausted',
            tx,
          );
          return { retried: false, reason: 'state' };
        }
        const scheduledFor = new Date(
          now().getTime() + preSendBackoffMs(attemptRow.attemptNumber, attempt.retryAfterMs),
        );
        await move(
          row,
          'retryable_pre_send',
          { scheduledFor, claimedAt: null, claimant: workflowIdOf(row), stateReason: 'retry_pre_send' },
          'publication.retry',
          attempt.errorCode ?? null,
          tx,
        );
        return { retried: true, scheduledFor: scheduledFor.toISOString() };
      }),
  };

  /** Loads what one provider call needs, with the fence checked against the live row. */
  async function loadForProvider(input: {
    publicationId: string;
    attemptId: string | null;
    fencingToken?: number;
  }) {
    const row = await publicationsRepo.getById(input.publicationId);
    if (input.fencingToken !== undefined) assertFence(row, input.fencingToken);
    const attempt = input.attemptId ? await loadAttempt(row, input.attemptId) : null;
    if (attempt && input.fencingToken !== undefined && attempt.fencingToken !== input.fencingToken)
      throw new ValidationFailedError([{ path: 'attemptId', issue: 'attempt_fence_mismatch' }]);
    const connection = await connectionsRepo.getById(row.channelConnectionId);
    const variant = await variants.get(row.channelVariantId);
    return { row, attempt, connection, variant, adapter: adapterFor(connection.providerKey) };
  }

  const provider: PublishProviderRuntimeV1 = {
    /**
     * Spec 14.3/14.5: sentAt is committed immediately before the first outbound mutation; a repeat after sentAt never
     * re-sends (it reports unknown). An adapter's retryable_error with no sentAt goes back to scheduled; with sentAt
     * the workflow reconciles.
     */
    async publishOnce(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<AttemptResult> {
      const { tenantId, attemptId } = input;
      const { row, attempt, connection, variant, adapter } = await loadForProvider(input);
      if (!attempt) throw new NotFoundError('PublicationAttempt', attemptId);
      if (attempt.finishedAt) return attemptResultOf(attempt);
      if (attempt.sentAt) {
        const unknown: AttemptResult = {
          attemptId,
          outcome: 'unknown',
          errorCode: 'resumed_after_send',
          errorDetail: 'attempt already sent; never re-sent',
        };
        await withTransaction((tx) => recordAttemptOutcome(attemptId, unknown, tx));
        return unknown;
      }
      let result: AttemptResult;
      try {
        const media = await publishMedia.forVariant(variant, {
          providerProcessingWindowSec: adapter.capability.media.publicUrlFetch.processingWindowSec,
        });
        const req: PublishRequest = {
          publicationId: row.id,
          attemptId,
          idempotencyKey: attempt.providerIdempotencyKey ?? attemptId,
          remoteAccountId: connection.remoteAccountId,
          text: variant.text,
          media: media.map((m, i) => ({
            ...m,
            ...(variant.altTexts[i] ? { altText: variant.altTexts[i] } : {}),
          })),
          settings: variant.settings,
          textFingerprint: hashText(variant.text),
          mediaFingerprints: variant.exportHashes,
        };
        result = await credentialBroker.withCredentials(tenantId, connection.id, async (creds) => {
          // The ledger commits sentAt immediately before the first mutation leaves (not before reads, media fetches
          // or the rate limiter), so a failure proven before it is retried with backoff (spec 14.3).
          // The pre-send fence: sentAt commits under the row lock only while the row is still dispatching under this
          // attempt's token, so a move that committed first (a restore hold, worker loss declared by the sweeper, a
          // re-release to a newer claim) stops the send; a throw here aborts the request as before_send.
          const io: ProviderIO = providerIO(adapter.key, tenantId, hooks, async () => {
            hooks?.heartbeat(`publish:${attemptId}:before_send`);
            await withTransaction(async (tx) => {
              const locked = await publicationsRepo.lock(row.id, tx);
              if (locked.state !== 'dispatching')
                throw new ValidationFailedError([
                  { path: 'publicationId', issue: `send_in_state:${locked.state}` },
                ]);
              assertFence(locked, attempt.fencingToken);
              await attemptsRepo.markSent(attemptId, now(), tx);
            });
          });
          try {
            return fromOutcome(attemptId, await adapter.publish(req, creds, io));
          } catch (err) {
            if (err instanceof ProviderTransportError) {
              const cls = adapter.classifyError({ phase: err.phase, error: err });
              const classified = fromOutcome(attemptId, outcomeFromClass(cls, err.message));
              return err.phase === 'after_send' && classified.outcome === 'retryable_error'
                ? {
                    attemptId,
                    outcome: 'unknown',
                    errorCode: err.code,
                    errorDetail: truncateForTemporal(err),
                  }
                : classified;
            }
            return {
              attemptId,
              outcome: 'unknown',
              errorCode: 'adapter_error',
              errorDetail: truncateForTemporal(err),
            };
          }
        });
      } catch (err) {
        // Before any mutation (media, credentials, rate limiter): proven no effect, retryable with backoff.
        if (
          err instanceof ProviderRateLimitWaitExceeded ||
          (err instanceof ProviderTransportError && err.phase === 'before_send')
        )
          result = {
            attemptId,
            outcome: 'retryable_error',
            errorCode: 'pre_send',
            errorDetail: truncateForTemporal(err),
            retryAfterMs: 5_000,
          };
        else if (err instanceof PolicyDeniedError)
          result = {
            attemptId,
            outcome: 'rejected',
            errorCode: err.reason,
            errorDetail: truncateForTemporal(err),
          };
        else if (err instanceof ReleaseIntegrityError) {
          // Spec 3.g4: the export bytes no longer hash to what the approval pinned. Nothing was sent; the
          // publication is held for a person (never retried) and the attempt is closed as rejected.
          result = {
            attemptId,
            outcome: 'rejected',
            errorCode: EXPORT_HASH_MISMATCH,
            errorDetail: truncateForTemporal(err),
          };
          await withTransaction(async (tx) => {
            const locked = await publicationsRepo.lock(row.id, tx);
            if (locked.state !== 'dispatching') return;
            await move(
              locked,
              'release_policy_failed',
              { holdReasons: [EXPORT_HASH_MISMATCH], stateReason: EXPORT_HASH_MISMATCH },
              'publication.hold',
              EXPORT_HASH_MISMATCH,
              tx,
            );
          });
        } else throw err;
      }
      await withTransaction((tx) => recordAttemptOutcome(attemptId, result, tx));
      return result;
    },

    async checkStatus(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<PendingCheck> {
      const { attempt, connection, adapter } = await loadForProvider(input);
      if (!attempt?.pendingState)
        return { status: 'failed', code: 'no_pending_state', message: 'nothing to poll' };
      const checkStatus = adapter.checkStatus?.bind(adapter);
      if (!checkStatus)
        return { status: 'failed', code: 'not_supported', message: 'provider has no status check' };
      const check = await credentialBroker.withCredentials(input.tenantId, connection.id, (creds) =>
        checkStatus(
          PendingState.parse(attempt.pendingState),
          creds,
          providerIO(adapter.key, input.tenantId, hooks),
        ),
      );
      if (check.status === 'completed')
        await withTransaction((tx) => attemptsRepo.attachRemotePost(attempt.id, check.remotePostId, tx));
      return check;
    },

    async finalize(input: PublishOnceInputV1, hooks?: ActivityHooks): Promise<PendingCheck> {
      const { attempt, connection, adapter } = await loadForProvider(input);
      if (!attempt?.pendingState)
        return { status: 'failed', code: 'no_pending_state', message: 'nothing to finalise' };
      const finalize = adapter.finalize?.bind(adapter);
      if (!finalize) return { status: 'failed', code: 'not_supported', message: 'provider has no finalize' };
      const check = await credentialBroker.withCredentials(input.tenantId, connection.id, (creds) =>
        finalize(
          PendingState.parse(attempt.pendingState),
          creds,
          providerIO(adapter.key, input.tenantId, hooks),
        ),
      );
      if (check.status === 'completed')
        await withTransaction((tx) => attemptsRepo.attachRemotePost(attempt.id, check.remotePostId, tx));
      return check;
    },

    /** Read-only reconciliation (spec 14.3): by id or by fingerprint scan, from the attempt's start time. */
    async findRemotePost(input: FindRemotePostInputV1, hooks?: ActivityHooks): Promise<ReconcileResult> {
      const { row, attempt, connection, variant, adapter } = await loadForProvider(input);
      return credentialBroker.withCredentials(input.tenantId, connection.id, (creds) =>
        adapter.findRemotePost(
          {
            publicationId: row.id,
            attemptStartedAt: attempt?.startedAt ?? row.claimedAt ?? row.createdAt,
            textFingerprint: hashText(variant.text),
            mediaFingerprints: variant.exportHashes,
            remoteAccountId: connection.remoteAccountId,
          },
          creds,
          providerIO(adapter.key, input.tenantId, hooks),
        ),
      );
    },
  };

  const tokenRefresh: TokenRefreshRuntimeV1 = {
    async readRefreshSchedule({ channelConnectionId }: TokenRefreshWorkflowInputV1) {
      const row = await connectionsRepo.getById(channelConnectionId);
      return {
        status: row.status,
        tokenExpiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : null,
      };
    },

    /** Spec 14.7 refresh: under a per-connection lock, a new credential row version; failure flags the connection. */
    async refreshCredentials({
      tenantId,
      channelConnectionId,
    }: TokenRefreshWorkflowInputV1): Promise<RefreshCredentialsResultV1> {
      const lock = await refreshLock.hit(
        `lock:token-refresh:${tenantId}:${channelConnectionId}`,
        REFRESH_LOCK_SECONDS,
      );
      if (lock.count > 1) return { ok: false, reason: 'locked' };
      const row = await connectionsRepo.getById(channelConnectionId);
      if (row.status !== 'active' && row.status !== 'refresh_needed')
        return { ok: false, reason: 'not_active' };
      const adapter = adapterFor(row.providerKey);
      let refreshed: Awaited<ReturnType<typeof adapter.refresh>>;
      try {
        refreshed = await credentialBroker.withCredentials(tenantId, row.id, (creds) =>
          adapter.refresh(creds, providerClientFor(adapter.key), providerIO(adapter.key, tenantId)),
        );
      } catch (err) {
        refreshed =
          err instanceof PolicyDeniedError && err.reason === 'credential_destroyed'
            ? { ok: false, reason: 'reconnect_required' }
            : { ok: false, reason: 'transient' };
        // Name and code only (as provider-io logs): a token endpoint error message can carry a URL with secrets.
        if (refreshed.reason === 'transient')
          log.warn(
            {
              channelConnectionId,
              errorName: (err as Error)?.name,
              errorCode: (err as { code?: string })?.code,
            },
            'token refresh failed',
          );
      }
      return withTransaction(async (tx) => {
        const locked = await connectionsRepo.lock(row.id, tx);
        if (refreshed.ok) {
          const sealed = await credentialBroker.seal(tenantId, locked.id, refreshed.credentials);
          const credentialRefId = newId('credentialRef');
          await credentialsRepo.create({ id: credentialRefId, ...sealed }, tx);
          const tokenExpiresAt = refreshed.tokenExpiresAt ? new Date(refreshed.tokenExpiresAt) : null;
          await connectionsRepo.update(
            locked.id,
            locked.version,
            { credentialRefId, tokenExpiresAt, status: 'active' },
            tx,
          );
          const old = await credentialsRepo.getById(locked.credentialRefId, tx);
          if (!old.destroyedAt) await credentialsRepo.destroy(old.id, old.version, 'rotated', tx);
          await audit.record(
            workflowActor(),
            'channel.token_refresh',
            { type: 'channel_connection', id: locked.id },
            'allowed',
            tx,
            {
              brandId: locked.brandId,
              channelConnectionId: locked.id,
              fromState: locked.status,
              toState: 'active',
            },
          );
          return { ok: true, tokenExpiresAt: tokenExpiresAt ? tokenExpiresAt.toISOString() : null };
        }
        const status = refreshed.reason === 'reconnect_required' ? 'reconnect_needed' : 'refresh_needed';
        if (locked.status !== status) await connectionsRepo.update(locked.id, locked.version, { status }, tx);
        count(METRIC.tokenRefreshFailures, 1, { providerKey: locked.providerKey, reason: refreshed.reason });
        if (status === 'reconnect_needed')
          count(METRIC.reconnectNeeded, 1, { providerKey: locked.providerKey });
        await audit.record(
          workflowActor(),
          'channel.token_refresh',
          { type: 'channel_connection', id: locked.id },
          'denied',
          tx,
          {
            brandId: locked.brandId,
            channelConnectionId: locked.id,
            fromState: locked.status,
            toState: status,
            reason: refreshed.reason,
          },
        );
        await outbox.add(
          'channel.reconnect_needed',
          { type: 'channel_connection', id: locked.id, version: locked.version + 1 },
          {
            channelConnectionId: locked.id,
            providerKey: locked.providerKey,
            status,
            reason: refreshed.reason,
          },
          tx,
          { brandId: locked.brandId },
        ); // notifies the brand's publishers
        return { ok: false, reason: refreshed.reason };
      });
    },
  };

  const sweep: PublicationSweepRuntimeV1 = {
    /**
     * Always-on safety net: a `scheduled` row past due with no running workflow gets its start re-emitted; a
     * `dispatching` claim older than the lease with no running workflow is worker loss → outcome_unknown, and a
     * reconcile workflow is requested. Finding anything is logged and counted (it means something else broke).
     */
    async sweepPublications(input: PublicationSweepInputV1): Promise<SweepResultV1> {
      const at = new Date(input.now);
      const stuck = await runAsPlatform('publication-sweeper', input.correlationId, () =>
        sweepRepo.findStuck(at, input.graceSeconds, input.claimLeaseSeconds),
      );
      const summary: SweepResultV1 = { scheduledReemitted: 0, dispatchingExpired: 0 };
      for (const ref of stuck) {
        const workflowId = workflowIdOf({ id: ref.publicationId, claimant: ref.claimant });
        if (await workflowRunning(workflowId)) continue;
        await runInTenant(
          {
            tenantId: ref.tenantId,
            actor: { kind: 'service_principal', id: 'publication-sweeper' },
            brandIds: 'all',
            correlationId: input.correlationId,
          },
          () =>
            withTransaction(async (tx) => {
              const row = await publicationsRepo.lock(ref.publicationId, tx);
              if (row.state === 'scheduled') {
                await outbox.add(
                  'publication.scheduled',
                  { type: 'publication', id: row.id, version: row.version },
                  {
                    publicationId: row.id,
                    scheduledFor: row.scheduledFor.toISOString(),
                    workflowId,
                    rerelease: false,
                    actorKind: row.scheduledByKind,
                    actorId: row.scheduledById,
                    sweeper: true,
                  },
                  tx,
                  { brandId: row.brandId },
                );
                summary.scheduledReemitted += 1;
                log.warn(
                  { tenantId: row.tenantId, publicationId: row.id },
                  'sweeper re-emitted a past-due publication start',
                );
              } else if (row.state === 'dispatching') {
                const attempt = await attemptsRepo.findByFence(row.id, row.fencingToken, tx);
                const connection = await connectionsRepo.getById(row.channelConnectionId, tx);
                if (attempt && !attempt.finishedAt)
                  await recordAttemptOutcome(
                    attempt.id,
                    { attemptId: attempt.id, outcome: 'unknown', errorCode: 'worker_lost' },
                    tx,
                  );
                await move(
                  row,
                  'ambiguous_failure',
                  { stateReason: 'claim_lease_expired' },
                  'publication.outcome_unknown',
                  'claim_lease_expired',
                  tx,
                );
                count(METRIC.outcomeUnknownCount, 1);
                await outbox.add(
                  'publication.reconcile_requested',
                  { type: 'publication', id: row.id, version: row.version + 1 },
                  {
                    publicationId: row.id,
                    attemptId: attempt?.id ?? null,
                    providerKey: connection.providerKey,
                    workflowId: reconcileWorkflowId(row.id, row.version + 1),
                    actorKind: row.scheduledByKind,
                    actorId: row.scheduledById,
                  },
                  tx,
                  { brandId: row.brandId },
                );
                summary.dispatchingExpired += 1;
                log.warn(
                  { tenantId: row.tenantId, publicationId: row.id },
                  'sweeper found an expired dispatch claim (worker loss)',
                );
              }
            }),
        );
      }
      return summary;
    },
  };

  return { control, provider, tokenRefresh, sweep };
}
