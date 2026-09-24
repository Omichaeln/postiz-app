import {
  ExperimentAssign,
  ExperimentCreate,
  ExperimentGet,
  ExperimentList,
  ExperimentPreRegister,
  ExperimentResults,
  ExperimentResultsGet,
  ExperimentStart,
  ExperimentStop,
} from '@oremedia/contracts/experiments';
import { experimentsService } from '@oremedia/module-experiments';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 experiments router (spec 16.6: design, pre-register, start, stop, results, assignment). */
export const experimentsRouter = router({
  create: tenantMutation
    .input(ExperimentCreate)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => experimentsService.create(ctx.tenant.actor, input, tx)),
    ),
  preRegister: tenantMutation
    .input(ExperimentPreRegister)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => experimentsService.preRegister(ctx.tenant.actor, input, tx)),
    ),
  start: tenantMutation
    .input(ExperimentStart)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => experimentsService.start(ctx.tenant.actor, input, tx)),
    ),
  stop: tenantMutation
    .input(ExperimentStop)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => experimentsService.stop(ctx.tenant.actor, input, tx)),
    ),
  results: router({
    compute: tenantMutation
      .input(ExperimentResults)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => experimentsService.results(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(ExperimentResultsGet)
      .query(({ ctx, input }) => experimentsService.resultsGet(ctx.tenant.actor, input)),
  }),
  assign: tenantMutation
    .input(ExperimentAssign)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => experimentsService.assign(ctx.tenant.actor, input, tx)),
    ),
  list: tenantQuery
    .input(ExperimentList)
    .query(({ ctx, input }) => experimentsService.list(ctx.tenant.actor, input)),
  get: tenantQuery
    .input(ExperimentGet)
    .query(({ ctx, input }) => experimentsService.get(ctx.tenant.actor, input)),
});
