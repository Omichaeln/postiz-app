import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { TokenRefreshActivitiesV1, TokenRefreshWorkflowInputV1 } from '@oremedia/contracts/publishing';

/**
 * Spec 14.7, ported in shape from Postiz apps/orchestrator/src/workflows/refresh.token.workflow.ts: one workflow
 * per connection (workflow id `token-refresh:<channelConnectionId>`) sleeps until tokenExpiresAt - margin, re-reads
 * the row (it may have been disconnected meanwhile), refreshes under the per-connection lock in the activity and
 * loops; a failure leaves the connection flagged refresh_needed / reconnect_needed and ends the run. The payload
 * carries channelConnectionId only (R5). Once deployed this file is immutable; changes ship as v2.
 */
export const REFRESH_MARGIN_MS = 30 * 60_000;
/** A transient failure is retried this many times, spaced out, before the row stays refresh_needed. */
export const TRANSIENT_RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000] as const;
/** Without an expiry the provider's tokens do not expire: nothing to do until a reconnect starts a new run. */

export interface TokenRefreshHost {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type TokenRefreshOutcome =
  'refreshed' | 'not_active' | 'no_expiry' | 'reconnect_needed' | 'refresh_needed';

/** One cycle: wait for the margin, re-read, refresh. Exposed for unit tests with fakes. */
export async function runTokenRefreshCycle(
  acts: TokenRefreshActivitiesV1,
  input: TokenRefreshWorkflowInputV1,
  host: TokenRefreshHost,
): Promise<TokenRefreshOutcome> {
  let schedule = await acts.readRefreshSchedule(input);
  if (schedule.status !== 'active' && schedule.status !== 'refresh_needed') return 'not_active';
  if (!schedule.tokenExpiresAt) return 'no_expiry';
  const waitMs = Date.parse(schedule.tokenExpiresAt) - REFRESH_MARGIN_MS - host.now();
  if (waitMs > 0) await host.sleep(waitMs);
  // While we were sleeping the connection may have been disconnected or reconnected.
  schedule = await acts.readRefreshSchedule(input);
  if (schedule.status !== 'active' && schedule.status !== 'refresh_needed') return 'not_active';
  for (let i = 0; ; i++) {
    const result = await acts.refreshCredentials(input);
    if (result.ok) return 'refreshed';
    if (result.reason === 'reconnect_required') return 'reconnect_needed';
    if (result.reason === 'not_active') return 'not_active';
    const delay = TRANSIENT_RETRY_DELAYS_MS[i];
    if (delay === undefined) return 'refresh_needed';
    await host.sleep(delay); // 'locked' (another refresh in flight) or 'transient'
  }
}

export async function tokenRefreshWorkflowV1(
  input: TokenRefreshWorkflowInputV1,
): Promise<TokenRefreshOutcome> {
  const acts = proxyActivities<TokenRefreshActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['PolicyDenied', 'ValidationFailed'] },
  });
  const outcome = await runTokenRefreshCycle(acts, input, {
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
  });
  if (outcome !== 'refreshed') return outcome;
  await continueAsNew<typeof tokenRefreshWorkflowV1>(input); // next expiry, fresh history
  return outcome;
}
