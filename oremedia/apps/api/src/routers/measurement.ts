import {
  CreativeAttributesCorrect,
  CreativeAttributesGet,
  EngagementQualityGet,
  MetricDefinitionCreate,
  MetricDefinitionGet,
  MetricDefinitionList,
  MetricsQueryV1,
  TrackedLinkList,
} from '@oremedia/contracts/measurement';
import {
  attributeService,
  definitionService,
  linkService,
  metricService,
} from '@oremedia/module-measurement';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 measurement router (15.1 definitions, 15.2 query with freshness, 15.3 quality, 15.4 links, 16.2 attributes). */
export const measurementRouter = router({
  definitions: router({
    list: tenantQuery
      .input(MetricDefinitionList)
      .query(({ ctx, input }) => definitionService.list(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(MetricDefinitionGet)
      .query(({ ctx, input }) => definitionService.get(ctx.tenant.actor, input)),
    create: tenantMutation
      .input(MetricDefinitionCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => definitionService.create(ctx.tenant.actor, input, tx)),
      ),
  }),
  metrics: router({
    query: tenantQuery
      .input(MetricsQueryV1)
      .query(({ ctx, input }) => metricService.query(ctx.tenant.actor, input)),
  }),
  quality: router({
    get: tenantQuery
      .input(EngagementQualityGet)
      .query(({ ctx, input }) => metricService.quality(ctx.tenant.actor, input)),
  }),
  links: router({
    list: tenantQuery
      .input(TrackedLinkList)
      .query(({ ctx, input }) => linkService.list(ctx.tenant.actor, input)),
  }),
  attributes: router({
    get: tenantQuery
      .input(CreativeAttributesGet)
      .query(({ ctx, input }) => attributeService.get(ctx.tenant.actor, input)),
    correct: tenantMutation
      .input(CreativeAttributesCorrect)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => attributeService.correct(ctx.tenant.actor, input, tx)),
      ),
  }),
});
