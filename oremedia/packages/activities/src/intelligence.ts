import type {
  AnalystSweepActivitiesV1,
  AnalystSweepRuntimeV1,
  BaselineComparisonActivitiesV1,
  BaselineComparisonRuntimeV1,
  BrandAnalystActivitiesV1,
  BrandAnalystRuntimeV1,
} from '@oremedia/contracts/intelligence';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { withLogContext } from '@oremedia/observability';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { heartbeat, inTenant } from './tenant';

/**
 * Spec 16.3 / 16.8 activities for brandAnalystWorkflowV1 and baselineComparisonWorkflowV1 (task queue `core`):
 * thin wrappers that establish tenant context as the analyst's service principal (re-loading its grants at the
 * point of effect, spec 5.2) and translate domain errors into the failure types the workflows' retry policies
 * understand. Every effect lives in the intelligence module's runtime (createIntelligenceRuntime).
 */
const guarded =
  <I extends TenantContextInput, R>(fn: (input: I) => Promise<R>) =>
  async (input: I): Promise<R> => {
    try {
      return await inTenant(input, loadActorGrants, () => fn(input));
    } catch (err) {
      throw toActivityFailure(err);
    }
  };

export function createBrandAnalystActivities(runtime: BrandAnalystRuntimeV1): BrandAnalystActivitiesV1 {
  return {
    prepareAnalysis: guarded((input) => {
      heartbeat('analysis:prepare');
      return runtime.prepareAnalysis(input);
    }),
    readAnalystRun: guarded((input) => runtime.readAnalystRun(input)),
    recordAnalystOutcome: guarded((input) => runtime.recordAnalystOutcome(input)),
  };
}

/** The sweeps are platform-level (no tenant input); the runtime's target source spans tenants by design. */
export function createAnalystSweepActivities(runtime: AnalystSweepRuntimeV1): AnalystSweepActivitiesV1 {
  return {
    listAnalystTargets: (input) =>
      withLogContext({ correlationId: input.correlationId }, () => runtime.listAnalystTargets(input)),
  };
}

export function createBaselineComparisonActivities(
  runtime: BaselineComparisonRuntimeV1,
): BaselineComparisonActivitiesV1 {
  return {
    listBaselineTargets: (input) =>
      withLogContext({ correlationId: input.correlationId }, () => runtime.listBaselineTargets(input)),
    compareRankingBaseline: guarded((input) => runtime.compareRankingBaseline(input)),
  };
}
