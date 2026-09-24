import { proxyActivities, workflowInfo } from '@temporalio/workflow';
import type {
  BaselineComparisonActivitiesV1,
  BaselineComparisonInputV1,
  BaselineComparisonScheduleArgsV1,
  CompareRankingResultV1,
} from '@oremedia/contracts/intelligence';

/**
 * Spec 16.8 baseline comparison (mandatory baseline): monthly, for every brand with an analyst principal, the
 * learned recommendation ranking is scored against the stable baseline on the outcomes observed since the
 * recommendations were ranked; when it does not beat the baseline by the stated margin the comparison records
 * the fallback and the baseline is used. Started by a Temporal schedule; each brand is one activity so one
 * brand's failure never blocks the others. Once deployed this file is immutable; changes ship as v2.
 */
export const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed'];
export const COMPARISON_PERIOD_DAYS = 30;

export interface BaselineComparisonSummary {
  compared: number;
  failed: number;
  fallbacks: number;
  results: CompareRankingResultV1[];
}

export async function runBaselineComparison(
  acts: BaselineComparisonActivitiesV1,
  input: BaselineComparisonInputV1,
): Promise<BaselineComparisonSummary> {
  const targets = await acts.listBaselineTargets(input);
  const periodEnd = input.now;
  const periodStart = new Date(Date.parse(input.now) - COMPARISON_PERIOD_DAYS * 86_400_000).toISOString();
  const summary: BaselineComparisonSummary = { compared: 0, failed: 0, fallbacks: 0, results: [] };
  for (const t of targets) {
    try {
      const result = await acts.compareRankingBaseline({
        tenantId: t.tenantId,
        actor: { kind: 'service_principal', id: t.servicePrincipalId },
        correlationId: `${input.correlationId}:${t.brandId}`,
        brandId: t.brandId,
        periodStart,
        periodEnd,
      });
      summary.compared += 1;
      if (!result.beaten) summary.fallbacks += 1;
      summary.results.push(result);
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

export async function baselineComparisonWorkflowV1(
  args: BaselineComparisonScheduleArgsV1 = {},
): Promise<BaselineComparisonSummary> {
  const input: BaselineComparisonInputV1 = {
    correlationId: args.correlationId ?? `baseline-comparison:${workflowInfo().runId}`,
    now: args.now ?? new Date(Date.now()).toISOString(),
  };
  const acts = proxyActivities<BaselineComparisonActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '5s',
      maximumInterval: '2 minutes',
      maximumAttempts: 3,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  return runBaselineComparison(acts, input);
}
