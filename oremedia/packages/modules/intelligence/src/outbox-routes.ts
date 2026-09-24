import { BrandAnalystWorkflowInputV1 } from '@oremedia/contracts/intelligence';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Spec 4.4: worker-core hosts task queue `core`; the analyst and the baseline comparison run there. */
export const CORE_TASK_QUEUE = 'core';
export const BRAND_ANALYST_WORKFLOW_TYPE = 'brandAnalystWorkflowV1';
export const ANALYST_SWEEP_WORKFLOW_TYPE = 'brandAnalystSweepWorkflowV1';
export const BASELINE_COMPARISON_WORKFLOW_TYPE = 'baselineComparisonWorkflowV1';
/** One weekly schedule and one monthly schedule per namespace (worker-core creates them at start). */
export const ANALYST_SCHEDULE_ID = 'brand-analyst-weekly';
export const BASELINE_COMPARISON_SCHEDULE_ID = 'ranking-baseline-monthly';

export const brandAnalystWorkflowId = (brandId: string, periodEnd: string): string =>
  `brand-analyst:${brandId}:${periodEnd.slice(0, 10)}`;

/**
 * Spec 16.3 on demand: intelligence.analysis_due → brandAnalystWorkflowV1 with the stable workflow id the command
 * chose (one analysis per brand and day; the outbox row is the dedupe authority). The workflow's actor is the
 * analyst's service principal, re-resolved by every activity (spec 5.2).
 */
export function registerIntelligenceOutboxRoutes(): void {
  registerOutboxRoute('intelligence.analysis_due', (evt) => {
    const p = evt.payload;
    const input = BrandAnalystWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: 'service_principal', id: p['servicePrincipalId'] },
      correlationId: evt.correlationId,
      brandId: p['brandId'],
      servicePrincipalId: p['servicePrincipalId'],
      periodStart: p['periodStart'],
      periodEnd: p['periodEnd'],
    });
    return {
      workflowType: BRAND_ANALYST_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: String(p['workflowId']),
      args: [input],
    };
  });
}
