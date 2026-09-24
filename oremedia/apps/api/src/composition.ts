import { registerBrandChecker, MembershipRepository } from '@oremedia/module-access';
import { experimentsService, registerExperimentListener } from '@oremedia/module-experiments';
import {
  intelligenceService,
  registerExperimentDesigner,
  registerExperimentSource,
  registerMetricsSource,
  registerPublicationVolumeSource,
} from '@oremedia/module-intelligence';
import { assetService } from '@oremedia/module-assets';
import { registerUsageCounters } from '@oremedia/module-billing';
import { brandService } from '@oremedia/module-brand';
import {
  creativeService,
  registerAssetAuthoriser,
  registerRevisionChangeHook,
} from '@oremedia/module-creative';
import {
  registerAttributeCapturer,
  registerCalendarSource,
  registerChannelResolver,
  registerLinkTracker,
  registerRevisionChangeListener,
  contentService,
} from '@oremedia/module-content';
import {
  attributeService,
  configureLinkTracking,
  linkService,
  linkTrackingFromEnv,
  metricService,
  registerCommentSink,
  registerMeasurementBrandChecker,
} from '@oremedia/module-measurement';
import {
  channelService,
  configureCredentialBroker,
  createKmsFromEnv,
  publicationService,
  registerProviderClients,
  providerClientsFromEnv,
  registerPublishMediaSource,
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
  // Spec 9.3 / 14.5: the exports a variant publishes, as signed release URLs minted at dispatch. The creative
  // module reads the export rows; the assets module re-verifies the bytes against the pinned hash (spec 3.g4)
  // and mints the URL for the provider's processing window.
  registerPublishMediaSource({
    describe: (variant, tx) => creativeService.renders.exportsByIds(variant.brandId, variant.exportIds, tx),
    release: async (variant, { providerProcessingWindowSec }, tx) => {
      const media = [];
      for (const e of await creativeService.renders.exportsByIds(variant.brandId, variant.exportIds, tx))
        media.push(
          await assetService.releaseExport(
            { ...e, brandId: variant.brandId, exportId: e.id },
            providerProcessingWindowSec,
            tx,
          ),
        );
      return media;
    },
  });
  registerReleaseCheckers({
    channelUsable: (channelConnectionId, tx) => channelService.channelUsable(channelConnectionId, tx),
    validateVariant: (channelVariantId, tx) => channelService.validateVariant(channelVariantId, tx),
    countForMandateOnDay: (mandateId, at, tx) => publicationService.countForMandateOnDay(mandateId, at, tx),
  });
  registerChannelResolver((channelConnectionId, tx) => channelService.describe(channelConnectionId, tx));
  registerCalendarSource((brandId, from, to, tx) => publicationService.calendarRange(brandId, from, to, tx));
  registerProviderClients(providerClientsFromEnv());
  // Spec 15.4 / 16.2: variant links are tracked and creative attributes captured at creation (measurement hooks).
  registerMeasurementBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  configureLinkTracking(linkTrackingFromEnv());
  registerLinkTracker((input, tx) => linkService.trackVariantLinks(input, tx));
  registerAttributeCapturer(async (input, tx) => {
    await attributeService.capture(input, tx);
  });
  // Spec 16: the intelligence module reads metrics, experiments and publication volume through hooks; the
  // experiments module reports milestones for the learning record; ingested comments feed the voice library.
  registerMetricsSource(async (actor, query, tx) => {
    const publications = await publicationService.calendarRange(
      query.brandId,
      new Date(query.windowStart),
      new Date(query.windowEnd),
      tx,
    );
    if (publications.length === 0)
      return {
        values: [],
        coverage: {
          subjectsRequested: 0,
          subjectsWithData: 0,
          metricsRequested: query.metricKeys,
          metricsWithData: [],
          metricsUnavailable: query.metricKeys,
          staleValues: 0,
          windowStart: query.windowStart,
          windowEnd: query.windowEnd,
        },
      };
    const result = await metricService.query(
      actor,
      {
        brandId: query.brandId,
        subjectType: 'publication',
        subjectIds: publications.map((p) => p.publicationId).slice(0, 200),
        metricKeys: query.metricKeys,
        windowStart: query.windowStart,
        windowEnd: query.windowEnd,
        grouping: 'metric',
      },
      tx,
    );
    return { values: result.values, coverage: result.coverage };
  });
  registerExperimentDesigner((actor, input, tx, opts) => experimentsService.create(actor, input, tx, opts));
  registerExperimentSource((brandId, tx) => experimentsService.listForBrand(brandId, tx));
  registerPublicationVolumeSource(
    async (brandId, from, to, tx) => (await publicationService.calendarRange(brandId, from, to, tx)).length,
  );
  registerExperimentListener((milestone, tx) =>
    intelligenceService.learning.onExperimentMilestone(milestone, tx),
  );
  registerCommentSink(async (comments, tx) => {
    for (const c of comments)
      await intelligenceService.voice.ingest(
        {
          brandId: c.brandId,
          messageId: c.messageId,
          text: c.text,
          authorHash: c.authorHash,
          remoteCreatedAt: c.remoteCreatedAt,
        },
        tx,
      );
  });
  if (process.env['KMS_LOCAL_MASTER_SECRET'])
    configureCredentialBroker({ kms: createKmsFromEnv({ decrypt: false }) });
}
