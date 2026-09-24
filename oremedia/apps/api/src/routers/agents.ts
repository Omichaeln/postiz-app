import {
  RoutingPolicySet,
  RunApproveProposal,
  RunCancel,
  RunGet,
  RunStart,
  RunSteps,
} from '@oremedia/contracts/agents';
import { agentsService } from '@oremedia/module-agents';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 agents router (spec 12: runs start through the outbox; decisions and cancels are relayed to the workflow). */
export const agentsRouter = router({
  runs: router({
    start: tenantMutation
      .input(RunStart)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => agentsService.runs.start(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery.input(RunGet).query(({ ctx, input }) => agentsService.runs.get(ctx.tenant.actor, input)),
    cancel: tenantMutation
      .input(RunCancel)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => agentsService.runs.cancel(ctx.tenant.actor, input, tx)),
      ),
    steps: tenantQuery
      .input(RunSteps)
      .query(({ ctx, input }) => agentsService.runs.steps(ctx.tenant.actor, input)),
    approveProposal: tenantMutation
      .input(RunApproveProposal)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => agentsService.runs.approveProposal(ctx.tenant.actor, input, tx)),
      ),
  }),
  /** Spec 12.7 tenant model-routing policy: read and replaced by a tenant administrator (billing.manage). */
  routingPolicy: router({
    get: tenantQuery.query(({ ctx }) => agentsService.routingPolicy.get(ctx.tenant.actor)),
    set: tenantMutation
      .input(RoutingPolicySet)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => agentsService.routingPolicy.set(ctx.tenant.actor, input, tx)),
      ),
  }),
});
