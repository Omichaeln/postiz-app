import { proxyActivities } from '@temporalio/workflow';
import type {
  BrandChangeImpactActivitiesV1,
  BrandChangeImpactInputV1,
  BrandChangeImpactResultV1,
} from '@oremedia/contracts/brand-change-impact';

/**
 * Spec 8.2 / 13.2: brand.version_published and brand.fact_revoked → brandChangeImpactWorkflowV1 on task queue
 * `core` (workflow id `brand-change:<outbox event id>`). Deterministic orchestration only: invalidate the brand's
 * approvals and open requests, then either re-evaluate every scheduled publication of the brand (a published
 * version changes the approval binding) or apply the revoked fact under the brand's policy (hold, or flag and
 * keep the state). Every activity re-establishes tenant context (spec 5.2) and is idempotent, so retries and a
 * redelivered event are safe. Once deployed this file is immutable; changes ship as v2.
 */

/** Domain errors that no retry can fix (a foreign id, a lost permission, an illegal state). */
const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed'];

/** The orchestration, separated from the activity proxies so it can be exercised with fakes. */
export async function runBrandChangeImpact(
  acts: BrandChangeImpactActivitiesV1,
  input: BrandChangeImpactInputV1,
): Promise<BrandChangeImpactResultV1> {
  const approvals = await acts.invalidateApprovals(input);
  if (input.change.kind === 'fact_revoked') {
    const facts = await acts.applyFactRevocation({ ...input, factId: input.change.factId });
    return {
      ...approvals,
      publicationsHeld: facts.held.length,
      publicationsFlagged: facts.flagged.length,
      publicationsUnchanged: facts.unchanged.length,
    };
  }
  const release = await acts.reevaluateScheduledPublications(input);
  return {
    ...approvals,
    publicationsHeld: release.held.length,
    publicationsFlagged: 0,
    publicationsUnchanged: release.unchanged.length,
  };
}

export async function brandChangeImpactWorkflowV1(
  input: BrandChangeImpactInputV1,
): Promise<BrandChangeImpactResultV1> {
  const acts = proxyActivities<BrandChangeImpactActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '2s',
      maximumInterval: '1 minute',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  return runBrandChangeImpact(acts, input);
}
