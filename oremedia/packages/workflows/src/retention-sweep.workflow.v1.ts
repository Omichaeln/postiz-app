import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type {
  RetentionActivitiesV1,
  RetentionSweepArgsV1,
  RetentionSweepInputV1,
} from '@oremedia/contracts/operations';

/**
 * Spec 17.5 TTL job (task queue `core`), started daily by the Temporal schedule `retention-sweep`: every tenant's
 * retention_policies (or the spec defaults) are applied by the handlers the modules registered, one tenant per
 * activity, so one tenant's failure never blocks the others. `dryRun` counts what would be removed and deletes
 * nothing. Once deployed this file is immutable; changes ship as v2.
 */
export interface RetentionSweepOutcome {
  dryRun: boolean;
  tenants: number;
  failed: number;
  rows: number;
}

/** The orchestration, separated from the activity proxies so it runs with fakes in unit tests. */
export async function runRetentionSweep(
  acts: RetentionActivitiesV1,
  input: RetentionSweepInputV1,
): Promise<RetentionSweepOutcome> {
  const tenants = await acts.listRetentionTenants(input);
  const outcome: RetentionSweepOutcome = { dryRun: input.dryRun, tenants: 0, failed: 0, rows: 0 };
  for (const tenantId of tenants) {
    try {
      const result = await acts.applyRetention({ ...input, tenantId });
      outcome.tenants += 1;
      outcome.rows += result.classes.reduce((n, c) => n + c.rows, 0);
    } catch {
      outcome.failed += 1; // retried on the next day's run; the activity already retried transient errors
    }
  }
  return outcome;
}

export async function retentionSweepWorkflowV1(
  args: RetentionSweepArgsV1 = {},
): Promise<RetentionSweepOutcome> {
  const acts = proxyActivities<RetentionActivitiesV1>({
    startToCloseTimeout: '30 minutes',
    retry: { initialInterval: '30s', maximumAttempts: 3 },
  });
  // A schedule starts this with fixed args: the workflow's deterministic clock and run id fill the rest.
  const input: RetentionSweepInputV1 = {
    correlationId: args.correlationId ?? `retention-sweep:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
    dryRun: args.dryRun ?? true,
  };
  return runRetentionSweep(acts, input);
}
