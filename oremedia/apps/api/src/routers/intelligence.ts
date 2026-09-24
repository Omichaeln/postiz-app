import {
  AnalystRun,
  AnomalyList,
  InsightList,
  PlaybookApprove,
  PlaybookList,
  PlaybookPropose,
  RecommendationAccept,
  RecommendationDismiss,
  RecommendationGet,
  RecommendationList,
  VoiceClustersList,
  WorkspaceGet,
} from '@oremedia/contracts/intelligence';
import { intelligenceService } from '@oremedia/module-intelligence';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 intelligence router (spec 16: insights, recommendation actions, playbook, customer voice, workspace). */
export const intelligenceRouter = router({
  insights: router({
    list: tenantQuery
      .input(InsightList)
      .query(({ ctx, input }) => intelligenceService.insights.list(ctx.tenant.actor, input)),
  }),

  recommendations: router({
    list: tenantQuery
      .input(RecommendationList)
      .query(({ ctx, input }) => intelligenceService.recommendations.list(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(RecommendationGet)
      .query(({ ctx, input }) => intelligenceService.recommendations.get(ctx.tenant.actor, input)),
    accept: tenantMutation
      .input(RecommendationAccept)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          intelligenceService.recommendations.accept(ctx.tenant.actor, input, tx),
        ),
      ),
    dismiss: tenantMutation
      .input(RecommendationDismiss)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          intelligenceService.recommendations.dismiss(ctx.tenant.actor, input, tx),
        ),
      ),
  }),

  playbook: router({
    list: tenantQuery
      .input(PlaybookList)
      .query(({ ctx, input }) => intelligenceService.playbook.list(ctx.tenant.actor, input)),
    propose: tenantMutation
      .input(PlaybookPropose)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          intelligenceService.playbook.propose(ctx.tenant.actor, input, tx),
        ),
      ),
    approve: tenantMutation
      .input(PlaybookApprove)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          intelligenceService.playbook.approve(ctx.tenant.actor, input, tx),
        ),
      ),
  }),

  voice: router({
    clusters: tenantQuery
      .input(VoiceClustersList)
      .query(({ ctx, input }) => intelligenceService.voice.clusters(ctx.tenant.actor, input)),
  }),

  anomalies: router({
    list: tenantQuery
      .input(AnomalyList)
      .query(({ ctx, input }) => intelligenceService.anomalies.list(ctx.tenant.actor, input)),
  }),

  workspace: router({
    get: tenantQuery
      .input(WorkspaceGet)
      .query(({ ctx, input }) => intelligenceService.workspace.get(ctx.tenant.actor, input)),
  }),

  analyst: router({
    run: tenantMutation
      .input(AnalystRun)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => intelligenceService.analyst.run(ctx.tenant.actor, input, tx)),
      ),
  }),
});
