import type {
  BrandChangeImpactActivitiesV1,
  BrandChangeImpactRuntimeV1,
} from '@oremedia/contracts/brand-change-impact';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { logger } from '@oremedia/observability';
import { toActivityFailure } from './agent-run';
import { loadActorGrants } from './actor';
import { inTenant } from './tenant';

/**
 * Spec 8.2 activities for brandChangeImpactWorkflowV1 (task queue `core`): thin wrappers that establish tenant
 * context from the input (re-loading the publishing actor's grants at the point of effect, spec 5.2) and
 * translate domain errors into the failure types the workflow's retry policy understands, as the publish-control
 * activities do. Every effect lives in the runtime worker-core composes from the review, content and publishing
 * modules, and every effect is idempotent there: approvals already invalidated and publications already held are
 * no longer valid or scheduled and are not visited again.
 */
export function createBrandChangeImpactActivities(
  runtime: BrandChangeImpactRuntimeV1,
): BrandChangeImpactActivitiesV1 {
  const log = () => logger().child('brand-change-impact');
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
    invalidateApprovals: guarded((input) => runtime.invalidateApprovals(input.brandId)),
    reevaluateScheduledPublications: guarded(async (input) => {
      const result = await runtime.reevaluateScheduledPublications(
        input.brandId,
        `brand_${input.change.kind}`,
      );
      log().info(
        { brandId: input.brandId, held: result.held.length, unchanged: result.unchanged.length },
        'scheduled publications re-evaluated after brand change',
      );
      return result;
    }),
    applyFactRevocation: guarded(async (input) => {
      const result = await runtime.applyFactRevocation(input.brandId, input.factId);
      log().info(
        {
          brandId: input.brandId,
          hold: result.hold,
          held: result.held.length,
          flagged: result.flagged.length,
          unchanged: result.unchanged.length,
        },
        'revoked fact applied to scheduled publications',
      );
      return result;
    }),
  };
}
