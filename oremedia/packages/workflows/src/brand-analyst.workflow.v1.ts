import { ParentClosePolicy, proxyActivities, sleep, startChild, workflowInfo } from '@temporalio/workflow';
import type {
  AnalystSweepActivitiesV1,
  AnalystSweepInputV1,
  AnalystSweepScheduleArgsV1,
  BrandAnalystActivitiesV1,
  BrandAnalystWorkflowInputV1,
  RecordAnalystOutcomeResultV1,
} from '@oremedia/contracts/intelligence';

/**
 * Spec 16.3: the weekly (and on-demand) brand analyst. prepareAnalysis writes the deterministic movements and
 * starts the performance-review agent run (its own workflow on queue `agents`, spec 12.2); this workflow then
 * waits for that run to end by polling its state at a bounded cadence (the run's own deadline bounds the wait),
 * and recordAnalystOutcome ranks what the run proposed toward the brand objective. Activities throw
 * ApplicationFailure.nonRetryable(message, 'PolicyDenied' | 'ValidationFailed' | 'BudgetExhausted'). Once deployed
 * this file is immutable; changes ship as v2.
 */
export const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed', 'BudgetExhausted'];
/** Poll cadence while the run works and the longest this workflow waits for it (the run's deadline is ≤ 30 min). */
export const RUN_POLL_INTERVAL_MS = 30_000;
export const RUN_WAIT_LIMIT_MS = 45 * 60_000;

export interface BrandAnalystHost {
  sleep(ms: number): Promise<void>;
}

export type BrandAnalystOutcome =
  | { outcome: 'skipped'; reason: string; changeInsights: number }
  | ({ outcome: 'recorded'; runId: string | null; runState: string } & RecordAnalystOutcomeResultV1);

/** The orchestration, separated from the activity proxies so it runs with fakes in unit tests. */
export async function runBrandAnalyst(
  acts: BrandAnalystActivitiesV1,
  input: BrandAnalystWorkflowInputV1,
  host: BrandAnalystHost,
): Promise<BrandAnalystOutcome> {
  const prepared = await acts.prepareAnalysis(input);
  if (prepared.skippedReason && prepared.changeInsightIds.length === 0)
    return { outcome: 'skipped', reason: prepared.skippedReason, changeInsights: 0 };
  let runState = prepared.runId ? 'planned' : `not_started:${prepared.skippedReason ?? 'unknown'}`;
  if (prepared.runId) {
    let waited = 0;
    for (;;) {
      const run = await acts.readAnalystRun({ ...input, runId: prepared.runId });
      runState = run.state;
      if (run.terminal) break;
      if (waited >= RUN_WAIT_LIMIT_MS) {
        runState = `wait_limit:${run.state}`;
        break;
      }
      await host.sleep(RUN_POLL_INTERVAL_MS);
      waited += RUN_POLL_INTERVAL_MS;
    }
  }
  const recorded = await acts.recordAnalystOutcome({
    ...input,
    runId: prepared.runId,
    runState,
    changeInsightIds: prepared.changeInsightIds,
  });
  return { outcome: 'recorded', runId: prepared.runId, runState, ...recorded };
}

export async function brandAnalystWorkflowV1(
  input: BrandAnalystWorkflowInputV1,
): Promise<BrandAnalystOutcome> {
  const acts = proxyActivities<BrandAnalystActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '5s',
      maximumInterval: '2 minutes',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  return runBrandAnalyst(acts, input, { sleep: (ms) => sleep(ms) });
}

/** How the sweep starts one analysis per target; the workflow uses a child workflow, tests a fake. */
export interface AnalystSweepHost {
  startAnalysis(input: BrandAnalystWorkflowInputV1, workflowId: string): Promise<void>;
}

export const ANALYST_PERIOD_DAYS = 7;
export const analystWorkflowId = (brandId: string, periodEnd: string): string =>
  `brand-analyst:${brandId}:${periodEnd.slice(0, 10)}`;

/** The weekly sweep (a Temporal schedule starts it): every active brand with an analyst principal gets one run. */
export async function runAnalystSweep(
  acts: AnalystSweepActivitiesV1,
  input: AnalystSweepInputV1,
  host: AnalystSweepHost,
): Promise<{ started: number; failed: number }> {
  const targets = await acts.listAnalystTargets(input);
  const periodEnd = input.now;
  const periodStart = new Date(Date.parse(input.now) - ANALYST_PERIOD_DAYS * 86_400_000).toISOString();
  let started = 0;
  let failed = 0;
  for (const t of targets) {
    const child: BrandAnalystWorkflowInputV1 = {
      tenantId: t.tenantId,
      actor: { kind: 'service_principal', id: t.servicePrincipalId },
      correlationId: `${input.correlationId}:${t.brandId}`,
      brandId: t.brandId,
      servicePrincipalId: t.servicePrincipalId,
      periodStart,
      periodEnd,
    };
    try {
      await host.startAnalysis(child, analystWorkflowId(t.brandId, periodEnd));
      started += 1;
    } catch {
      failed += 1; // one brand's failure (e.g. an id already running today) never blocks the others
    }
  }
  return { started, failed };
}

export async function brandAnalystSweepWorkflowV1(
  args: AnalystSweepScheduleArgsV1 = {},
): Promise<{ started: number; failed: number }> {
  const acts = proxyActivities<AnalystSweepActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: { maximumAttempts: 3 },
  });
  // A schedule starts this with fixed args: the workflow's deterministic clock and run id fill the rest.
  const input: AnalystSweepInputV1 = {
    correlationId: args.correlationId ?? `analyst-sweep:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
  };
  return runAnalystSweep(acts, input, {
    async startAnalysis(child, workflowId) {
      await startChild(brandAnalystWorkflowV1, {
        args: [child],
        workflowId,
        parentClosePolicy: ParentClosePolicy.ABANDON,
      });
    },
  });
}
