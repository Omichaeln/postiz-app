import type {
  MetricCollectionActivitiesV1,
  MetricCollectionRuntimeV1,
} from '@oremedia/contracts/measurement';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
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
    pullMetrics: guarded((input) => {
      heartbeat(`metrics:${input.publicationId}:${input.pullIndex}:start`);
      return runtime.pullMetrics(input, { heartbeat });
    }),
  };
}
