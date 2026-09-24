import { continueAsNew, proxyActivities, sleep } from '@temporalio/workflow';
import type { PublicationSweepActivitiesV1, SweepResultV1 } from '@oremedia/contracts/publishing';

/**
 * Always-on safety net for spec 14.2/14.3: past-due `scheduled` rows with no running workflow get their start
 * re-emitted; `dispatching` claims older than the lease with no running workflow are worker loss → outcome_unknown
 * and reconciled. One execution per namespace (workflow id `publication-sweeper`, USE_EXISTING); the history is
 * bounded by continue-as-new. Once deployed this file is immutable; changes ship as v2.
 */
export interface SweeperInputV1 {
  intervalSeconds: number;
  claimLeaseSeconds: number;
  graceSeconds: number;
  /** Passes before continue-as-new keeps the history short. */
  passesPerRun?: number;
}

export const SWEEPER_DEFAULTS: Required<SweeperInputV1> = {
  intervalSeconds: 60,
  claimLeaseSeconds: 20 * 60,
  graceSeconds: 120,
  passesPerRun: 500,
};

export interface SweeperHost {
  now(): number;
  sleep(ms: number): Promise<void>;
  correlationId(pass: number): string;
}

/** One bounded run: `passes` sweeps, then the caller continues as new. Exposed for unit tests with fakes. */
export async function runSweeperPasses(
  acts: PublicationSweepActivitiesV1,
  input: Required<SweeperInputV1>,
  host: SweeperHost,
): Promise<SweepResultV1> {
  const total: SweepResultV1 = { scheduledReemitted: 0, dispatchingExpired: 0 };
  for (let pass = 0; pass < input.passesPerRun; pass++) {
    const result = await acts.sweepPublications({
      correlationId: host.correlationId(pass),
      now: new Date(host.now()).toISOString(),
      claimLeaseSeconds: input.claimLeaseSeconds,
      graceSeconds: input.graceSeconds,
    });
    total.scheduledReemitted += result.scheduledReemitted;
    total.dispatchingExpired += result.dispatchingExpired;
    await host.sleep(input.intervalSeconds * 1000);
  }
  return total;
}

export async function publicationSweeperWorkflowV1(input: Partial<SweeperInputV1> = {}): Promise<void> {
  const cfg: Required<SweeperInputV1> = { ...SWEEPER_DEFAULTS, ...input };
  const acts = proxyActivities<PublicationSweepActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 3 },
  });
  await runSweeperPasses(acts, cfg, {
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
    correlationId: (pass) => `sweeper:${pass}`,
  });
  await continueAsNew<typeof publicationSweeperWorkflowV1>(cfg);
}
