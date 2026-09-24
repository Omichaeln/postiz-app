import {
  registerBrandChecker,
  MembershipRepository,
  ServicePrincipalRepository,
} from '@oremedia/module-access';
import {
  experimentsService,
  registerExperimentListener,
  registerRecommendationResolver,
} from '@oremedia/module-experiments';
import {
  intelligenceService,
  intelligenceToolSource,
  registerAnalystTargetSource,
  registerExperimentDesigner,
  registerExperimentSource,
  registerIntelligenceOutboxRoutes,
  registerMetricsSource,
  registerPublicationVolumeSource,
} from '@oremedia/module-intelligence';
import { runInTenant } from '@oremedia/db';
import { registerOperationsOutboxRoutes, registerRetentionTenantSource } from '@oremedia/module-operations';
import { registerDeletionHandlers, registerRetentionHandlers } from './deletion-handlers';
import { assetService, registerAssetOutboxRoutes } from '@oremedia/module-assets';
import { registerUsageCounters } from '@oremedia/module-billing';
import { brandService, registerEligibleTemplateSource } from '@oremedia/module-brand';
import {
  creativeService,
  registerAssetAuthoriser,
  registerCreativeOutboxRoutes,
} from '@oremedia/module-creative';
import { registerAgentOutboxRoutes } from '@oremedia/module-agents';
import {
  registerBrandChecker as registerSkillBrandChecker,
  registerEvaluationRunner,
  registerSkillOutboxRoutes,
  skillsService,
} from '@oremedia/module-skills';
import {
  createEvaluationRunnerFromEnv,
  createReleaseOneRegistry,
  registerContentToolSource,
  registerIntelligenceToolSource,
  registerPublishingToolSource,
  registerReviewToolSource,
  registerSkillResolver,
} from '@oremedia/ai';
import {
  contentService,
  contentToolSource,
  registerAttributeCapturer,
  registerCalendarSource,
  registerChannelResolver,
  registerLinkTracker,
} from '@oremedia/module-content';
import {
  attributeService,
  configureLinkTracking,
  linkService,
  linkTrackingFromEnv,
  registerMeasurementBrandChecker,
  registerMeasurementOutboxRoutes,
  metricService,
  registerCommentSink,
} from '@oremedia/module-measurement';
import {
  registerReleaseCheckers,
  registerReviewOutboxRoutes,
  reviewService,
  reviewToolSource,
} from '@oremedia/module-review';
import {
  channelService,
  publicationService,
  publishingToolSource,
  registerProviderClients,
  registerRevisionVariantSource,
  providerClientsFromEnv,
  registerPublishingOutboxRoutes,
  registerPublishMediaSource,
  registerApprovalConsumer,
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
export function composeModules(opts: { workflowProbe?: WorkflowProbe } = {}): void {
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
  // Spec 19.6: sandbox evaluations run here, not in the API (adapters come from the environment on first use).
  registerEvaluationRunner(createEvaluationRunnerFromEnv(createReleaseOneRegistry()));
  // Spec 14: publications start and are signalled through the outbox on task queue `core`; the runtime reads
  // variants and the release decision through hooks (the worker's KMS may decrypt: publishing-worker.ts).
  registerPublishingOutboxRoutes();
  // Spec 8.2: brand.version_published / brand.fact_revoked → brandChangeImpactWorkflowV1 on task queue `core`.
  registerReviewOutboxRoutes();
  registerPublishingBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  registerVariantSource((variantId, tx) => contentService.variants.read(variantId, tx));
  registerReleaseEvaluator((pub, at, tx) => reviewService.evaluateRelease(pub, at, tx));
  // Spec 13.1: a release approval is spent (valid → consumed) with the publication it authorised.
  registerApprovalConsumer(async (approvalId, publicationId, publishedChannelConnectionIds, tx) => {
    await reviewService.approvals.consume(approvalId, tx, publicationId, publishedChannelConnectionIds);
  });
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
    publishedElsewhereForApprovalChannel: (approvalId, channelConnectionId, exceptPublicationId, tx) =>
      publicationService.publishedElsewhereForApprovalChannel(
        approvalId,
        channelConnectionId,
        exceptPublicationId,
        tx,
      ),
  });
  registerChannelResolver((channelConnectionId, tx) => channelService.describe(channelConnectionId, tx));
  registerCalendarSource((brandId, from, to, tx) => publicationService.calendarRange(brandId, from, to, tx));
  registerProviderClients(providerClientsFromEnv());
  registerWorkflowProbe(opts.workflowProbe ?? null);
  // Spec 15: measurement.collection_due starts the collection on worker-ingest's queues; variant links and
  // creative attributes are captured here too because agents run content commands in this process.
  registerMeasurementOutboxRoutes();
  registerMeasurementBrandChecker({ assertExist: (ids, tx) => brandService.assertExist(ids, tx) });
  configureLinkTracking(linkTrackingFromEnv());
  registerLinkTracker((input, tx) => linkService.trackVariantLinks(input, tx));
  registerAttributeCapturer(async (input, tx) => {
    await attributeService.capture(input, tx);
  });
  // Spec 16: intelligence.analysis_due → brandAnalystWorkflowV1 on `core`; the analyst's tools reach the module
  // through the generic registry hook; metrics, experiments and publication volume arrive through hooks; the
  // experiments module reports milestones for the learning record; ingested comments feed the voice library.
  registerIntelligenceOutboxRoutes();
  registerIntelligenceToolSource(intelligenceToolSource);
  // Spec 12.4: content.createBrief / content.draftCopy, review.request and publications.proposeSchedule reach their
  // modules through the same generic registry hooks; spec 8.3: the brand snapshot lists approved template versions.
  registerContentToolSource(contentToolSource);
  registerReviewToolSource(reviewToolSource);
  registerPublishingToolSource(publishingToolSource);
  registerRevisionVariantSource((contentRevisionId, tx) =>
    contentService.revisions.withVariants(contentRevisionId, tx),
  );
  registerEligibleTemplateSource((brandId, tx) => creativeService.templates.eligibleVersionIds(brandId, tx));
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
  registerRecommendationResolver((recommendationId, brandId, tx) =>
    intelligenceService.recommendations.belongsToBrand(recommendationId, brandId, tx),
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
          ...(c.classification ? { classification: c.classification } : {}),
        },
        tx,
      );
  });
  // Spec 17.5: operations.deletion_requested → deletionRequestWorkflowV1 on `core`; each module's rows, objects and
  // credentials are removed by the handlers registered here; the daily retention sweep visits every tenant with an
  // active brand and applies the TTL handlers.
  registerOperationsOutboxRoutes();
  registerDeletionHandlers();
  registerRetentionHandlers();
  registerRetentionTenantSource(async (correlationId) =>
    (await brandService.listActiveAcrossTenants('retention-sweep', correlationId)).map((r) => r.tenantId),
  );
  // Spec 16.3 weekly sweep / 16.8 monthly comparison: every active brand whose tenant has an active agent
  // principal granted agent.start_run and insight.manage (the analyst principal); brands without one are skipped.
  const principals = new ServicePrincipalRepository();
  registerAnalystTargetSource(async (correlationId) => {
    const refs = await brandService.listActiveAcrossTenants('brand-analyst-sweep', correlationId);
    const targets = [];
    const byTenant = new Map<string, string | null>();
    for (const ref of refs) {
      if (!byTenant.has(ref.tenantId)) {
        const found = await runInTenant(
          {
            tenantId: ref.tenantId,
            actor: { kind: 'service_principal', id: 'brand-analyst-sweep' },
            brandIds: 'all',
            correlationId,
          },
          async () =>
            (await principals.list()).find(
              (p) =>
                p.kind === 'agent' &&
                p.status === 'active' &&
                p.grants.some((g) => g.action === 'agent.start_run') &&
                p.grants.some((g) => g.action === 'insight.manage'),
            ) ?? null,
        );
        byTenant.set(ref.tenantId, found?.id ?? null);
      }
      const servicePrincipalId = byTenant.get(ref.tenantId);
      if (servicePrincipalId)
        targets.push({ tenantId: ref.tenantId, brandId: ref.brandId, servicePrincipalId });
    }
    return targets;
  });
}
