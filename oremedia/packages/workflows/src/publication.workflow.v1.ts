import {
  condition,
  defineSignal,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import type {
  AttemptResult,
  ClaimResultV1,
  PublicationReconcileInputV1,
  PublicationSignalV1,
  PublicationWorkflowInputV1,
  PublishControlActivitiesV1,
  PublishProviderActivitiesV1,
} from '@oremedia/contracts/publishing';

/**
 * Spec 14.3, literally: the durable wait re-reads the row (the row, not the input, is authoritative), the claim
 * carries a fencing token, release policy is re-evaluated at dispatch, the attempt row is committed before any
 * outbound call, publishOnce runs once (never a blind retry of a mutation) on the provider's own queue, and the
 * classified outcome drives the switch. Once deployed this file is immutable; changes ship as v2.
 */
export const cancelSignal = defineSignal('cancelSignal');
export const rescheduleSignal = defineSignal('rescheduleSignal');

type Claim = Extract<ClaimResultV1, { ok: true }>;

/** Domain errors that no retry can fix (a foreign id, a lost permission, an illegal state). */
const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed'];

/** Reconciliation schedule (spec 14.3 reconcile): findRemotePost at +1 m, +5 m, +15 m, +1 h, then a human. */
export const RECONCILE_DELAYS = ['1 minute', '5 minutes', '15 minutes', '1 hour'] as const;
/** Pending polling: bounded backoff from 15 s to 5 min, at most 6 hours of polling, then outcome_unknown. */
export const POLL_MIN_MS = 15_000;
export const POLL_MAX_MS = 5 * 60_000;
export const POLL_BUDGET_MS = 6 * 60 * 60_000;
/** The wait re-reads the row at least this often, so a reschedule is honoured even if its signal is lost. */
export const WAIT_REREAD_MS = 15 * 60_000;

/** The durable waits and signal state of the workflow, separated so the orchestration runs with fakes. */
export interface PublicationHost {
  workflowId: string;
  runId: string;
  cancelRequested(): boolean;
  /** Consumes the reschedule flag (true when a reschedule arrived since the last call). */
  takeRescheduled(): boolean;
  now(): number;
  /** Resolves when a cancel or reschedule signal arrives or the wait elapses. */
  waitForSignal(ms: number): Promise<void>;
  sleep(ms: number | string): Promise<void>;
  /** Activity proxies bound to the provider's task queue (`publish-<providerKey>`), spec 4.4. */
  providerActivities(providerKey: string): {
    publish: PublishProviderActivitiesV1;
    lookup: PublishProviderActivitiesV1;
  };
}

const summarise = (err: unknown): string => {
  const e = err as { message?: string; cause?: { message?: string } } | undefined;
  return (e?.cause?.message ?? e?.message ?? String(err)).slice(0, 500);
};

/** Spec 14.3 reconcile(): read-only lookups on the provider queue, then a human (outcome_unknown → held). */
export async function runReconcile(
  control: PublishControlActivitiesV1,
  lookup: PublishProviderActivitiesV1,
  input: PublicationWorkflowInputV1,
  attemptId: string | null,
  host: Pick<PublicationHost, 'sleep'>,
): Promise<void> {
  await control.markOutcomeUnknown({ ...input, attemptId });
  for (const delay of RECONCILE_DELAYS) {
    await host.sleep(delay);
    const found = await lookup
      .findRemotePost({ ...input, attemptId })
      .catch((err) => ({ status: 'cannot_determine' as const, reason: summarise(err) }));
    if (found.status === 'found') {
      await control.markPublished({ ...input, evidence: { ...found, attemptId } }); // outcome_unknown → published
      return;
    }
    if (found.status === 'definitely_absent') {
      await control.markRetryEligible(input); // outcome_unknown → retry_eligible
      return;
    }
    // 'cannot_determine' → keep trying, then hand to a human
  }
  await control.holdForHuman({ ...input, reason: 'outcome_unknown_unresolved' }); // outcome_unknown → held
}

/** Spec 14.3 pollUntilSettled: read-only checkStatus / finalize with backoff; once finalised, completed stays completed. */
async function pollUntilSettled(
  control: PublishControlActivitiesV1,
  publish: PublishProviderActivitiesV1,
  lookup: PublishProviderActivitiesV1,
  input: PublicationWorkflowInputV1,
  claim: Claim,
  attempt: AttemptResult,
  host: PublicationHost,
): Promise<void> {
  await control.markProcessing({ ...input, attempt }); // dispatching → processing
  const call = { ...input, attemptId: attempt.attemptId, fencingToken: claim.fencingToken };
  const started = host.now();
  let delayMs = POLL_MIN_MS;
  while (host.now() - started < POLL_BUDGET_MS) {
    let check;
    try {
      check = await publish.checkStatus(call);
      // finalize is a mutation (maximumAttempts 1): an ambiguous or after-send failure throws (PendingCheck has
      // no `unknown`) and lands in reconciliation below, never in a retry of the finalising call.
      if (check.status === 'ready') check = await publish.finalize(call);
    } catch {
      break; // the outcome is unknown (processing → outcome_unknown), reconciled read-only
    }
    if (check.status === 'completed') {
      await control.markPublished({
        ...input,
        attempt: { ...attempt, remotePostId: check.remotePostId, remoteUrl: check.remoteUrl },
      });
      return;
    }
    if (check.status === 'failed') {
      await control.markFailed({
        ...input,
        attempt: { ...attempt, errorCode: check.code, errorDetail: check.message },
      });
      return;
    }
    await host.sleep(check.status === 'processing' && check.retryAfterMs ? check.retryAfterMs : delayMs);
    delayMs = Math.min(POLL_MAX_MS, delayMs * 2);
  }
  await runReconcile(control, lookup, input, attempt.attemptId, host); // processing → outcome_unknown → …
}

/** The orchestration, spec 14.3, with the activity proxies and signal state injected. */
export async function runPublication(
  control: PublishControlActivitiesV1,
  input: PublicationWorkflowInputV1,
  host: PublicationHost,
): Promise<void> {
  for (;;) {
    // Wait until due. Re-read schedule each time: the row, not the workflow input, is authoritative.
    for (;;) {
      host.takeRescheduled();
      const { scheduledFor, state } = await control.readSchedule(input);
      if (state !== 'scheduled') return;
      const waitMs = Date.parse(scheduledFor) - host.now();
      if (waitMs <= 0) break;
      await host.waitForSignal(Math.min(waitMs, WAIT_REREAD_MS));
      if (host.cancelRequested()) {
        await control.cancelIfNotStarted(input);
        return;
      }
    }

    // Claim with a fencing token; idempotent per run (the same claimant gets the same claim back).
    const claim = await control.claimForDispatch({ ...input, claimant: `${host.workflowId}:${host.runId}` });
    if (!claim.ok) return;

    const release = await control.evaluateRelease({ ...input, fencingToken: claim.fencingToken });
    if (!release.allow) {
      await control.hold({ ...input, reasons: release.reasons }); // dispatching → held
      return;
    }
    if (host.cancelRequested()) {
      await control.releaseClaimAndCancel({ ...input, fencingToken: claim.fencingToken });
      return;
    }

    // The attempt row is committed BEFORE any outbound call; its existence is what distinguishes
    // "never sent" from "maybe sent". Idempotent on (publicationId, fencingToken).
    const attemptId = await control.openAttempt({ ...input, fencingToken: claim.fencingToken });
    const { publish, lookup } = host.providerActivities(claim.providerKey);

    const attempt: AttemptResult = await publish
      .publishOnce({ ...input, attemptId, fencingToken: claim.fencingToken })
      .catch((err) => ({ attemptId, outcome: 'unknown' as const, error: summarise(err) })); // timeouts and worker loss

    switch (attempt.outcome) {
      case 'accepted':
        await control.markPublished({ ...input, attempt });
        return;
      case 'pending':
        await pollUntilSettled(control, publish, lookup, input, claim, attempt, host);
        return;
      case 'rejected':
        await control.markFailed({ ...input, attempt }); // definitive: validation, permission, content policy
        return;
      case 'retryable_error': {
        // Adapter proved pre-send; the ledger decides: no sentAt → back to scheduled with backoff (new attempt
        // later, same workflow keeps waiting); sentAt present → the outcome is unknown and is reconciled.
        const retry = await control.retryAfterProvenNoEffect({ ...input, attempt });
        if (retry.retried) continue;
        if (retry.reason === 'sent') await runReconcile(control, lookup, input, attemptId, host);
        return;
      }
      case 'unknown':
        await runReconcile(control, lookup, input, attemptId, host);
        return;
    }
  }
}

function providerProxies(providerKey: string) {
  const options = { taskQueue: `publish-${providerKey}` };
  return {
    publish: proxyActivities<PublishProviderActivitiesV1>({
      ...options,
      startToCloseTimeout: '15 minutes',
      heartbeatTimeout: '2 minutes',
      retry: { maximumAttempts: 1 }, // never let Temporal blindly retry a mutation
    }),
    // Read-only, safe to retry (checkStatus / finalize / findRemotePost).
    lookup: proxyActivities<PublishProviderActivitiesV1>({
      ...options,
      startToCloseTimeout: '2 minutes',
      retry: { maximumAttempts: 3, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES },
    }),
  };
}

const controlProxy = () =>
  proxyActivities<PublishControlActivitiesV1>({
    startToCloseTimeout: '1 minute',
    retry: { maximumAttempts: 5, nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES }, // every control activity is idempotent
  });

function temporalHost(): PublicationHost {
  const { workflowId, runId } = workflowInfo();
  let cancelRequested = false;
  let rescheduled = false;
  setHandler(cancelSignal, () => {
    cancelRequested = true;
  });
  setHandler(rescheduleSignal, () => {
    rescheduled = true; // wakes the wait so an earlier time is honoured
  });
  return {
    workflowId,
    runId,
    cancelRequested: () => cancelRequested,
    takeRescheduled: () => {
      const r = rescheduled;
      rescheduled = false;
      return r;
    },
    now: () => Date.now(), // workflow Date.now is deterministic in Temporal
    waitForSignal: async (ms) => {
      await condition(() => cancelRequested || rescheduled, ms);
    },
    sleep: (ms) => sleep(ms),
    providerActivities: (providerKey) => {
      const { publish, lookup } = providerProxies(providerKey);
      return {
        publish: {
          publishOnce: publish.publishOnce,
          checkStatus: lookup.checkStatus,
          finalize: publish.finalize, // a mutation: once only, like publishOnce
          findRemotePost: lookup.findRemotePost,
        },
        lookup,
      };
    },
  };
}

export async function publicationWorkflowV1(input: PublicationWorkflowInputV1): Promise<void> {
  return runPublication(controlProxy(), input, temporalHost());
}

/** Sweeper-detected worker loss: the same reconciliation loop, started on its own (outcome_unknown → …). */
export async function publicationReconcileWorkflowV1(input: PublicationReconcileInputV1): Promise<void> {
  const host = temporalHost();
  const { attemptId, providerKey, ...rest } = input;
  await runReconcile(controlProxy(), host.providerActivities(providerKey).lookup, rest, attemptId, host);
}

/**
 * Relays a cancel or reschedule from the outbox to the running publication workflow (spec 13.5). The API writes
 * the event in the command's transaction; the relay signals only after that commit. A relay for a run that already
 * ended fails harmlessly (the row already carries the final state).
 */
export async function publicationSignalRelayV1(input: PublicationSignalV1): Promise<void> {
  const handle = getExternalWorkflowHandle(input.workflowId);
  if (input.signal === 'cancel') await handle.signal(cancelSignal);
  else await handle.signal(rescheduleSignal);
}
