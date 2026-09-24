import { registerBrandChecker, MembershipRepository } from '@oremedia/module-access';
import { assetService, registerAssetOutboxRoutes } from '@oremedia/module-assets';
import { registerUsageCounters } from '@oremedia/module-billing';
import { brandService } from '@oremedia/module-brand';
import { registerAssetAuthoriser, registerCreativeOutboxRoutes } from '@oremedia/module-creative';
import {
  registerAgentOutboxRoutes,
  registerWorkflowSignaller,
  type WorkflowSignaller,
} from '@oremedia/module-agents';
import {
  registerBrandChecker as registerSkillBrandChecker,
  registerEvaluationRunner,
  registerSkillOutboxRoutes,
  skillsService,
} from '@oremedia/module-skills';
import { createEvaluationRunnerFromEnv, createReleaseOneRegistry, registerSkillResolver } from '@oremedia/ai';
import { contentService, registerCalendarSource, registerChannelResolver } from '@oremedia/module-content';
import { registerReleaseCheckers, reviewService } from '@oremedia/module-review';
import {
  channelService,
  publicationService,
  registerProviderClients,
  providerClientsFromEnv,
  registerPublishingOutboxRoutes,
  registerReleaseEvaluator,
  registerVariantSource,
  registerWorkflowProbe,
  registerPublishingBrandChecker,
  type WorkflowProbe,
} from '@oremedia/module-publishing';

/**
 * Wires cross-module hooks so modules never import each other's tables (same shape as apps/api/src/composition.ts),
 * plus the outbox routes that map events to workflow starts. Called by main and by tests.
 */
export function composeModules(
  opts: { signaller?: WorkflowSignaller; workflowProbe?: WorkflowProbe } = {},
): void {
  registerBrandChecker({
    assertExist: (ids, tx) => brandService.assertExist(ids, tx),
    assertValidGrantBrands: (ids, tx) => brandService.assertValidGrantBrands(ids, tx),
  });
  const memberships = new MembershipRepository();
  registerUsageCounters(async (_tenantId, tx) => ({
    brands: await brandService.count(tx),
    seats: await memberships.countActive(tx),
    channels: await channelService.countActive(tx),
  }));
  registerAssetAuthoriser(async (assetVersionId, ctx, tx) => {
    await assetService.authoriseUse(assetVersionId, ctx.purpose, { brandId: ctx.brandId }, tx);
  });
  registerAssetOutboxRoutes();
  registerCreativeOutboxRoutes();
  registerSkillOutboxRoutes();
  // Spec 12: agent runs start and are signalled through the outbox; the context resolver pins skills (spec 12.3).
  registerSkillBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  registerAgentOutboxRoutes();
  registerSkillResolver((input, tx) =>
    skillsService.resolveForRun(input.actor, { brandId: input.brandId, taskKind: input.taskKind }, tx),
  );
  registerWorkflowSignaller(opts.signaller ?? null);
  // Spec 19.6: sandbox evaluations run here, not in the API (adapters come from the environment on first use).
  registerEvaluationRunner(createEvaluationRunnerFromEnv(createReleaseOneRegistry()));
  // Spec 14: publications start and are signalled through the outbox on task queue `core`; the runtime reads
  // variants and the release decision through hooks (the worker's KMS may decrypt: publishing-worker.ts).
  registerPublishingOutboxRoutes();
  registerPublishingBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  registerVariantSource((variantId, tx) => contentService.variants.read(variantId, tx));
  registerReleaseEvaluator((pub, at, tx) => reviewService.evaluateRelease(pub, at, tx));
  registerReleaseCheckers({
    channelUsable: (channelConnectionId, tx) => channelService.channelUsable(channelConnectionId, tx),
    validateVariant: (channelVariantId, tx) => channelService.validateVariant(channelVariantId, tx),
    countForMandateOnDay: (mandateId, at, tx) => publicationService.countForMandateOnDay(mandateId, at, tx),
  });
  registerChannelResolver((channelConnectionId, tx) => channelService.describe(channelConnectionId, tx));
  registerCalendarSource((brandId, from, to, tx) => publicationService.calendarRange(brandId, from, to, tx));
  registerProviderClients(providerClientsFromEnv());
  registerWorkflowProbe(opts.workflowProbe ?? null);
}
