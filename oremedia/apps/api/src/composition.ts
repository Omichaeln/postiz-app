import { registerBrandChecker, MembershipRepository } from '@oremedia/module-access';
import { assetService } from '@oremedia/module-assets';
import { registerUsageCounters } from '@oremedia/module-billing';
import { brandService } from '@oremedia/module-brand';
import { registerAssetAuthoriser, registerRevisionChangeHook } from '@oremedia/module-creative';
import {
  registerCalendarSource,
  registerChannelResolver,
  registerRevisionChangeListener,
  contentService,
} from '@oremedia/module-content';
import {
  channelService,
  configureCredentialBroker,
  createKmsFromEnv,
  publicationService,
  registerProviderClients,
  providerClientsFromEnv,
  registerReleaseEvaluator,
  registerVariantSource,
  registerPublishingBrandChecker,
} from '@oremedia/module-publishing';
import {
  registerAssetAuthoriser as registerReleaseAssetAuthoriser,
  registerReleaseCheckers,
  reviewService,
} from '@oremedia/module-review';
import { registerBrandChecker as registerSkillBrandChecker, skillsService } from '@oremedia/module-skills';
import { registerSkillResolver } from '@oremedia/ai';

/** Wires cross-module hooks so modules never import each other's tables. Called by main and by tests. */
export function composeModules(): void {
  registerBrandChecker({
    assertExist: (ids, tx) => brandService.assertExist(ids, tx),
    assertValidGrantBrands: (ids, tx) => brandService.assertValidGrantBrands(ids, tx),
  });
  // Skills validate brand ids the same way (spec 4.2: the skills module never reads the brand tables).
  registerSkillBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  const memberships = new MembershipRepository();
  registerUsageCounters(async (_tenantId, tx) => ({
    brands: await brandService.count(tx),
    seats: await memberships.countActive(tx),
    channels: await channelService.countActive(tx),
  }));
  // Spec 11.4 guardAssets: every asset version an operation introduces is authorised for its purpose.
  registerAssetAuthoriser(async (assetVersionId, ctx, tx) => {
    await assetService.authoriseUse(assetVersionId, ctx.purpose, { brandId: ctx.brandId }, tx);
  });
  // Spec 12.3: the context resolver pins skill versions through the skills module. Spec 19.6: evaluation suites
  // are graded by worker-core (skillEvaluationWorkflowV1), never inside an API transaction.
  registerSkillResolver((input, tx) =>
    skillsService.resolveForRun(input.actor, { brandId: input.brandId, taskKind: input.taskKind }, tx),
  );
  // Spec 11.4 / 13.2: approvals are invalidated eagerly when a creative document or a content revision changes.
  registerRevisionChangeHook((documentId, tx) =>
    reviewService.approvals.invalidateForCreativeRevisionChange(documentId, tx),
  );
  registerRevisionChangeListener((change, tx) => reviewService.onContentRevisionChange(change, tx));
  // Spec 13.4 assets_rights_valid: every asset an export was rendered from is re-authorised at dispatch.
  registerReleaseAssetAuthoriser(async (assetVersionId, ctx, tx) => {
    await assetService.authoriseUse(
      assetVersionId,
      ctx.purpose,
      {
        brandId: ctx.brandId,
        channelConnectionIds: ctx.channelConnectionIds,
        scheduledFor: ctx.scheduledFor,
      },
      tx,
    );
  });
  // Spec 14.1 / 13.4 / 14.7: the publishing module reads variants and the release decision through hooks; the
  // content and review modules read channels and the checks the publishing module owns the same way. The API
  // process seals credentials but can never open them (WrapOnlyKms, spec 14.7).
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
  if (process.env['KMS_LOCAL_MASTER_SECRET'])
    configureCredentialBroker({ kms: createKmsFromEnv({ decrypt: false }) });
}
