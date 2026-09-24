import type { BrandChangeImpactRuntimeV1 } from '@oremedia/contracts/brand-change-impact';
import { withTransaction } from '@oremedia/db';
import { publicationService } from '@oremedia/module-publishing';
import { reviewService } from '@oremedia/module-review';

/**
 * Spec 8.2: the effects behind brandChangeImpactWorkflowV1's activities, composed here because the review module
 * (approvals, release policy, what a revoked fact reaches) and the publishing module (holding or flagging the
 * scheduled publications) never import each other (spec 4.2). Each effect is one transaction in the tenant
 * context the activity established (packages/activities/src/brand-change-impact.ts).
 */
export function createBrandChangeImpactRuntime(): BrandChangeImpactRuntimeV1 {
  return {
    invalidateApprovals: (brandId) =>
      withTransaction((tx) => reviewService.approvals.invalidateForBrandChange(brandId, tx)),
    reevaluateScheduledPublications: (brandId, reason) =>
      withTransaction((tx) => publicationService.reevaluateScheduledForBrand(brandId, reason, tx)),
    applyFactRevocation: (brandId, factId) =>
      withTransaction(async (tx) => {
        const scope = await reviewService.factRevocationScope(brandId, factId, tx);
        const applied = await publicationService.applyFactRevocation(
          { brandId, factId, contentRevisionIds: scope.contentRevisionIds, hold: scope.hold },
          tx,
        );
        return { hold: scope.hold, ...applied };
      }),
  };
}
