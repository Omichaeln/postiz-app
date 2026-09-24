import { NotFoundError } from '@oremedia/contracts/errors';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { FrozenManifestV1 } from '@oremedia/contracts/review';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import type { Tx } from '@oremedia/db';
import { contentService } from '@oremedia/module-content';
import { reviewService } from './service';

/**
 * Spec 12.4 review.request: what the generic tool in @oremedia/ai reaches when this module is composed
 * (registerReviewToolSource, structurally the ReviewToolSource there). The request is opened as the run's service
 * principal under the run's autonomy mode (review.request needs prepare_release); the revision must belong to the
 * run's brand (another brand's or tenant's is NOT_FOUND). Deciding stays with a person (review.decide is agent_never).
 */
export const reviewToolSource = {
  async requestReview(
    actor: ResolvedActorServicePrincipal,
    input: {
      brandId: string;
      runId: string;
      autonomyMode: AutonomyMode;
      contentRevisionId: string;
      assigneeUserIds: string[];
      dueAt?: string;
      timing: FrozenManifestV1['timing'];
    },
    tx: Tx,
  ): Promise<{ reviewRequestId: string; manifestHash: string }> {
    const revision = await contentService.revisions.read(input.contentRevisionId, tx); // tenant-scoped
    if (revision.brandId !== input.brandId)
      throw new NotFoundError('ContentRevision', input.contentRevisionId);
    const created = await reviewService.requests.create(
      actor,
      {
        contentRevisionId: revision.id,
        assigneeUserIds: input.assigneeUserIds,
        timing: input.timing,
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      },
      tx,
      { autonomyMode: input.autonomyMode },
    );
    return { reviewRequestId: created.reviewRequestId, manifestHash: created.manifestHash };
  },
};
