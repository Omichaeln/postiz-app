import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import type { Tx } from '@oremedia/db';
import { publicationService } from './publications';

/**
 * Spec 12.4 publications.proposeSchedule: what the generic tool in @oremedia/ai reaches when this module is composed
 * (registerPublishingToolSource, structurally the PublishingToolSource there). It only checks the proposed slot as
 * the run's service principal under the run's autonomy mode; the tool turns the result into a pending proposal a
 * person completes through publications.schedule. Nothing is scheduled or published from here.
 */
export const publishingToolSource = {
  async proposeSchedule(
    actor: ResolvedActorServicePrincipal,
    input: {
      brandId: string;
      runId: string;
      autonomyMode: AutonomyMode;
      contentRevisionId: string;
      channelConnectionIds: string[];
      proposedAt: string;
    },
    tx: Tx,
  ): Promise<{
    entries: Array<{ channelConnectionId: string; channelVariantId: string; scheduledFor: string }>;
  }> {
    const checked = await publicationService.proposeSchedule(
      actor,
      {
        brandId: input.brandId,
        contentRevisionId: input.contentRevisionId,
        channelConnectionIds: input.channelConnectionIds,
        scheduledFor: input.proposedAt,
      },
      tx,
      { autonomyMode: input.autonomyMode },
    );
    return { entries: checked.entries };
  },
};
