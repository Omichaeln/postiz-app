import type {
  MetricCollectionActivitiesV1,
  MetricCollectionRuntimeV1,
} from '@oremedia/contracts/measurement';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { METRIC, record } from '@oremedia/observability';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * Spec 15.1 metricCollectionWorkflowV1 activities (task queue `ingest-metrics`, worker-ingest): tenant context
 * from the input with the actor's grants re-loaded at the point of effect; the pull itself (broker, adapter,
 * rate limits, raw snapshots) lives in the measurement runtime. Payloads carry ids only (spec 14.7, R5).
 */
export function createMetricCollectionActivities(
  runtime: MetricCollectionRuntimeV1,
): MetricCollectionActivitiesV1 {
  const guarded =
    <I extends TenantContextInput, R>(fn: (input: I) => Promise<R>) =>
    async (input: I): Promise<R> => {
      try {
        return await inTenant(input, loadActorGrants, () => fn(input));
      } catch (err) {
        throw toActivityFailure(err);
      }
    };
  return {
    readCollectionPlan: guarded((input) => runtime.readCollectionPlan(input)),
    pullMetrics: guarded(async (input) => {
      heartbeat(`metrics:${input.publicationId}:${input.pullIndex}:start`);
      const result = await runtime.pullMetrics(input, { heartbeat });
      // Spec 17.2 ingest "keeping up": the pull's window end (when the data was due) → the pull finished.
      record(METRIC.ingestLagMs, Math.max(0, Date.now() - Date.parse(input.windowEnd)), {
        outcome: result.written > 0 ? 'written' : 'none',
      });
      return result;
    }),
  };
}
