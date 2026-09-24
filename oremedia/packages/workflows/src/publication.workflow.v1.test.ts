import { describe, expect, it } from 'vitest';
import type { PendingCheck, ReconcileResult } from '@oremedia/contracts/providers';
import type {
  AttemptResult,
  ClaimResultV1,
  PublicationState,
  PublicationWorkflowInputV1,
  PublishControlActivitiesV1,
  PublishProviderActivitiesV1,
  ReadScheduleResultV1,
  RetryResultV1,
  TransitionResultV1,
} from '@oremedia/contracts/publishing';
import {
  RECONCILE_DELAYS,
  runPublication,
  runReconcile,
  type PublicationHost,
} from './publication.workflow.v1';

const input: PublicationWorkflowInputV1 = {
  tenantId: 'ten_A',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'corr_pub',
  publicationId: 'pub_1',
};
const T0 = Date.parse('2026-09-24T10:00:00.000Z');

interface Options {
  /** The schedule reads, in order; the last one repeats. */
  schedules?: ReadScheduleResultV1[];
  claim?: ClaimResultV1;
  release?: { allow: true } | { allow: false; reasons: string[] };
  publish?: AttemptResult | (() => Promise<AttemptResult>);
  checks?: PendingCheck[];
  finalize?: PendingCheck;
  lookups?: ReconcileResult[];
  retry?: RetryResultV1;
  /** Signal the cancel after this many waits (0 = before the first wait completes). */
  cancelAfterWaits?: number;
  cancelBeforeClaim?: boolean;
  cancelAfterRelease?: boolean;
  rescheduleOnWait?: boolean;
}

const ok = (state: PublicationState): TransitionResultV1 => ({ state, version: 1, changed: true });
const scheduledAt = (iso: string, state: PublicationState = 'scheduled'): ReadScheduleResultV1 => ({
  state,
  scheduledFor: iso,
  version: 0,
});

function fakes(opts: Options = {}) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const sleeps: Array<number | string> = [];
  let clock = T0;
  let waits = 0;
  let cancelled = false;
  let rescheduled = false;
  let scheduleIndex = 0;
  const checks = [...(opts.checks ?? [])];
  const lookups = [...(opts.lookups ?? [])];
  const record =
    <I, R>(name: string, fn: (i: I) => Promise<R> | R) =>
    async (i: I): Promise<R> => {
      calls.push({ name, input: i });
      return fn(i);
    };
  const control: PublishControlActivitiesV1 = {
    readSchedule: record('readSchedule', () => {
      const list = opts.schedules ?? [scheduledAt(new Date(T0).toISOString())];
      const s = list[Math.min(scheduleIndex, list.length - 1)]!;
      scheduleIndex++;
      return s;
    }),
    cancelIfNotStarted: record('cancelIfNotStarted', () => ok('cancelled')),
    claimForDispatch: record('claimForDispatch', () => {
      if (opts.cancelAfterRelease) cancelled = true;
      return (
        opts.claim ?? {
          ok: true,
          fencingToken: 1,
          providerKey: 'fixture_provider',
          channelConnectionId: 'cc_1',
        }
      );
    }),
    evaluateRelease: record('evaluateRelease', () => opts.release ?? { allow: true }),
    hold: record('hold', () => ok('held')),
    releaseClaimAndCancel: record('releaseClaimAndCancel', () => ok('cancelled')),
    openAttempt: record('openAttempt', () => 'att_1'),
    markProcessing: record('markProcessing', () => ok('processing')),
    markPublished: record('markPublished', () => ok('published')),
    markFailed: record('markFailed', () => ok('failed')),
    markOutcomeUnknown: record('markOutcomeUnknown', () => ok('outcome_unknown')),
    markRetryEligible: record('markRetryEligible', () => ok('retry_eligible')),
    holdForHuman: record('holdForHuman', () => ok('held')),
    retryAfterProvenNoEffect: record(
      'retryAfterProvenNoEffect',
      () => opts.retry ?? { retried: false, reason: 'state' },
    ),
  };
  const provider: PublishProviderActivitiesV1 = {
    publishOnce: record('publishOnce', () => {
      const p = opts.publish ?? {
        attemptId: 'att_1',
        outcome: 'accepted',
        remotePostId: 'post_1',
        remoteUrl: 'https://x/1',
      };
      return typeof p === 'function' ? p() : p;
    }),
    checkStatus: record('checkStatus', () => checks.shift() ?? { status: 'ready' }),
    finalize: record(
      'finalize',
      () => opts.finalize ?? { status: 'completed', remotePostId: 'post_1', remoteUrl: 'https://x/1' },
    ),
    findRemotePost: record(
      'findRemotePost',
      () => lookups.shift() ?? { status: 'cannot_determine', reason: 'fixture' },
    ),
  };
  const host: PublicationHost = {
    workflowId: 'pub:pub_1',
    runId: 'run-uuid',
    cancelRequested: () => cancelled,
    takeRescheduled: () => {
      const r = rescheduled;
      rescheduled = false;
      return r;
    },
    now: () => clock,
    waitForSignal: async (ms) => {
      waits++;
      if (opts.cancelAfterWaits !== undefined && waits > opts.cancelAfterWaits) {
        cancelled = true;
        return;
      }
      if (opts.rescheduleOnWait && waits === 1) {
        rescheduled = true;
        clock += 1000; // woke early
        return;
      }
      clock += ms;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += typeof ms === 'number' ? ms : 60_000;
    },
    providerActivities: () => ({ publish: provider, lookup: provider }),
  };
  if (opts.cancelBeforeClaim) cancelled = true;
  return {
    control,
    provider,
    host,
    calls,
    sleeps,
    names: () => calls.map((c) => c.name),
    waits: () => waits,
  };
}

describe('publicationWorkflowV1 orchestration (spec 14.3)', () => {
  it('a due publication: readSchedule → claim → evaluateRelease → openAttempt → publishOnce (accepted) → markPublished', async () => {
    const f = fakes();
    await runPublication(f.control, input, f.host);
    expect(f.names()).toEqual([
      'readSchedule',
      'claimForDispatch',
      'evaluateRelease',
      'openAttempt',
      'publishOnce',
      'markPublished',
    ]);
    expect(f.calls[1]?.input).toMatchObject({ claimant: 'pub:pub_1:run-uuid' });
    expect(f.calls[3]?.input).toMatchObject({ fencingToken: 1 }); // the attempt row precedes the outbound call
    expect(f.calls[4]?.input).toMatchObject({ attemptId: 'att_1', fencingToken: 1, publicationId: 'pub_1' });
    expect(f.calls[5]?.input).toMatchObject({ attempt: { outcome: 'accepted', remotePostId: 'post_1' } });
  });

  it('waits until due, re-reading the row each loop; a non-scheduled state ends the run without a claim', async () => {
    const later = new Date(T0 + 60_000).toISOString();
    const f = fakes({ schedules: [scheduledAt(later), scheduledAt(later, 'cancelled')] });
    await runPublication(f.control, input, f.host);
    expect(f.names()).toEqual(['readSchedule', 'readSchedule']);
    expect(f.waits()).toBe(1);
  });

  it('a reschedule signal wakes the wait and the new (earlier) time is read from the row', async () => {
    const far = new Date(T0 + 3_600_000).toISOString();
    const soon = new Date(T0 + 500).toISOString();
    const f = fakes({ schedules: [scheduledAt(far), scheduledAt(soon)], rescheduleOnWait: true });
    await runPublication(f.control, input, f.host);
    expect(f.names().slice(0, 3)).toEqual(['readSchedule', 'readSchedule', 'claimForDispatch']);
    expect(f.names().at(-1)).toBe('markPublished');
  });

  it('cancel before the claim (during the wait) → cancelIfNotStarted, no claim, no attempt', async () => {
    const later = new Date(T0 + 60_000).toISOString();
    const f = fakes({ schedules: [scheduledAt(later)], cancelAfterWaits: 0 });
    await runPublication(f.control, input, f.host);
    expect(f.names()).toEqual(['readSchedule', 'cancelIfNotStarted']);
  });

  it('a claim that fails (row moved on) ends the run', async () => {
    const f = fakes({ claim: { ok: false, state: 'cancelled' } });
    await runPublication(f.control, input, f.host);
    expect(f.names()).toEqual(['readSchedule', 'claimForDispatch']);
  });

  it('a failed release check holds with its reasons and never opens an attempt', async () => {
    const f = fakes({ release: { allow: false, reasons: ['approval_matches', 'channel_active'] } });
    await runPublication(f.control, input, f.host);
    expect(f.names()).toEqual(['readSchedule', 'claimForDispatch', 'evaluateRelease', 'hold']);
    expect(f.calls[3]?.input).toMatchObject({ reasons: ['approval_matches', 'channel_active'] });
  });

  it('cancel that arrives during dispatch is honoured immediately before the attempt opens, never after', async () => {
    const f = fakes({ cancelAfterRelease: true });
    await runPublication(f.control, input, f.host);
    expect(f.names()).toEqual([
      'readSchedule',
      'claimForDispatch',
      'evaluateRelease',
      'releaseClaimAndCancel',
    ]);
    expect(f.names()).not.toContain('publishOnce');
  });

  it('a cancel that arrives after publishOnce started is not honoured; the outcome is recorded', async () => {
    const f = fakes({
      publish: async () => ({
        attemptId: 'att_1',
        outcome: 'accepted',
        remotePostId: 'post_1',
        remoteUrl: 'u',
      }),
    });
    const host = { ...f.host, cancelRequested: () => f.names().includes('publishOnce') };
    await runPublication(f.control, input, host);
    expect(f.names().at(-1)).toBe('markPublished');
    expect(f.names()).not.toContain('releaseClaimAndCancel');
  });

  it('rejected → markFailed', async () => {
    const f = fakes({ publish: { attemptId: 'att_1', outcome: 'rejected', errorCode: 'validation' } });
    await runPublication(f.control, input, f.host);
    expect(f.names().at(-1)).toBe('markFailed');
  });

  it('pending → markProcessing → poll (processing, ready → finalize → completed) → markPublished', async () => {
    const f = fakes({
      publish: { attemptId: 'att_1', outcome: 'pending', pending: { data: { postId: 'post_1' } } },
      checks: [{ status: 'processing', retryAfterMs: 10 }, { status: 'ready' }],
    });
    await runPublication(f.control, input, f.host);
    expect(f.names().slice(5)).toEqual([
      'markProcessing',
      'checkStatus',
      'checkStatus',
      'finalize',
      'markPublished',
    ]);
    expect(f.calls.at(-1)?.input).toMatchObject({ attempt: { remotePostId: 'post_1' } });
  });

  it('pending whose poll reports failed → markFailed', async () => {
    const f = fakes({
      publish: { attemptId: 'att_1', outcome: 'pending', pending: { data: {} } },
      checks: [{ status: 'failed', code: 'media_rejected', message: 'bad media' }],
    });
    await runPublication(f.control, input, f.host);
    expect(f.names().at(-1)).toBe('markFailed');
    expect(f.calls.at(-1)?.input).toMatchObject({ attempt: { errorCode: 'media_rejected' } });
  });

  it('retryable_error with no sentAt goes back to scheduled with backoff and a new attempt follows in the same run', async () => {
    let attempts = 0;
    const f = fakes({
      schedules: [scheduledAt(new Date(T0).toISOString()), scheduledAt(new Date(T0 + 30_000).toISOString())],
      publish: async () =>
        ++attempts === 1
          ? { attemptId: 'att_1', outcome: 'retryable_error', errorCode: 'pre_send', retryAfterMs: 5000 }
          : { attemptId: 'att_2', outcome: 'accepted', remotePostId: 'post_1', remoteUrl: 'u' },
      retry: { retried: true, scheduledFor: new Date(T0 + 30_000).toISOString() },
    });
    await runPublication(f.control, input, f.host);
    expect(f.names()).toEqual([
      'readSchedule',
      'claimForDispatch',
      'evaluateRelease',
      'openAttempt',
      'publishOnce',
      'retryAfterProvenNoEffect',
      'readSchedule',
      'readSchedule', // waited for the backoff, then re-read the row
      'claimForDispatch',
      'evaluateRelease',
      'openAttempt',
      'publishOnce',
      'markPublished',
    ]);
    expect(f.waits()).toBe(1); // it waited for the backoff
  });

  it('retryable_error with sentAt present is treated as unknown → reconcile', async () => {
    const f = fakes({
      publish: { attemptId: 'att_1', outcome: 'retryable_error', errorCode: 'ECONNRESET' },
      retry: { retried: false, reason: 'sent' },
      lookups: [{ status: 'found', remotePostId: 'post_9', remoteUrl: 'u', matchedBy: 'fingerprint' }],
    });
    await runPublication(f.control, input, f.host);
    expect(f.names().slice(5)).toEqual([
      'retryAfterProvenNoEffect',
      'markOutcomeUnknown',
      'findRemotePost',
      'markPublished',
    ]);
  });

  it('unknown (the activity threw: timeout, worker loss) → markOutcomeUnknown → findRemotePost at 1 m/5 m/15 m/1 h → held for a human', async () => {
    const f = fakes({
      publish: async () => {
        throw new Error('activity timed out');
      },
    });
    await runPublication(f.control, input, f.host);
    expect(f.names().slice(4)).toEqual([
      'publishOnce',
      'markOutcomeUnknown',
      'findRemotePost',
      'findRemotePost',
      'findRemotePost',
      'findRemotePost',
      'holdForHuman',
    ]);
    expect(f.sleeps).toEqual([...RECONCILE_DELAYS]);
    expect(f.calls.at(-1)?.input).toMatchObject({ reason: 'outcome_unknown_unresolved' });
    expect(f.calls[5]?.input).toMatchObject({ attemptId: 'att_1' });
  });

  it('reconciliation that finds the post publishes with the evidence (no second publish)', async () => {
    const f = fakes({
      publish: { attemptId: 'att_1', outcome: 'unknown', errorCode: 'ambiguous' },
      lookups: [
        { status: 'cannot_determine', reason: 'api down' },
        { status: 'found', remotePostId: 'post_1', remoteUrl: 'u', matchedBy: 'id' },
      ],
    });
    await runPublication(f.control, input, f.host);
    expect(f.names().filter((n) => n === 'publishOnce')).toHaveLength(1);
    expect(f.names().slice(-3)).toEqual(['findRemotePost', 'findRemotePost', 'markPublished']);
    expect(f.calls.at(-1)?.input).toMatchObject({
      evidence: { status: 'found', remotePostId: 'post_1', attemptId: 'att_1' },
    });
  });

  it('reconciliation that proves absence → retry_eligible (a human or policy re-schedules)', async () => {
    const f = fakes({
      publish: { attemptId: 'att_1', outcome: 'unknown', errorCode: 'ambiguous' },
      lookups: [{ status: 'definitely_absent' }],
    });
    await runPublication(f.control, input, f.host);
    expect(f.names().slice(-2)).toEqual(['findRemotePost', 'markRetryEligible']);
  });

  it('runReconcile on its own (sweeper-detected worker loss) tolerates a failing lookup as cannot_determine', async () => {
    const f = fakes();
    const failing = {
      ...f.provider,
      findRemotePost: async () => {
        throw new Error('provider unreachable');
      },
    };
    await runReconcile(f.control, failing, input, null, f.host);
    expect(f.names()).toEqual(['markOutcomeUnknown', 'holdForHuman']);
  });
});
