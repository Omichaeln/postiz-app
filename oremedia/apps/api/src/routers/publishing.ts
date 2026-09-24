import {
  CancelCommand,
  ChannelConnectComplete,
  ChannelConnectStart,
  ChannelDisconnect,
  ChannelList,
  PublicationDeleteRemote,
  PublicationEvidence,
  PublicationGet,
  PublicationList,
  ReconcileCommand,
  RescheduleCommand,
  ScheduleCommand,
} from '@oremedia/contracts/publishing';
import { channelService, publicationService } from '@oremedia/module-publishing';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

/** Spec 7.3: publication commands keep their idempotency record for 72 hours. */
const mutationCtx = (ctx: MutationCtx, ttlHours?: number) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
  ...(ttlHours ? { ttlHours } : {}),
});

/** Spec 7.5 publishing router (spec 14.1 scheduling joins the idempotent transaction; 13.5 cancel; 14.7 channels). */
export const publishingRouter = router({
  channels: router({
    connect: router({
      start: tenantMutation
        .input(ChannelConnectStart)
        .mutation(({ ctx, input }) =>
          idempotent(mutationCtx(ctx), (tx) => channelService.connect.start(ctx.tenant.actor, input, tx)),
        ),
      complete: tenantMutation
        .input(ChannelConnectComplete)
        .mutation(({ ctx, input }) =>
          idempotent(mutationCtx(ctx), (tx) => channelService.connect.complete(ctx.tenant.actor, input, tx)),
        ),
    }),
    list: tenantQuery
      .input(ChannelList)
      .query(({ ctx, input }) => channelService.list(ctx.tenant.actor, input)),
    disconnect: tenantMutation
      .input(ChannelDisconnect)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => channelService.disconnect(ctx.tenant.actor, input, tx)),
      ),
  }),
  publications: router({
    schedule: tenantMutation
      .input(ScheduleCommand)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) => publicationService.schedule(ctx.tenant.actor, input, tx)),
      ),
    cancel: tenantMutation
      .input(CancelCommand)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) => publicationService.cancel(ctx.tenant.actor, input, tx)),
      ),
    reschedule: tenantMutation
      .input(RescheduleCommand)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) => publicationService.reschedule(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(PublicationGet)
      .query(({ ctx, input }) => publicationService.get(ctx.tenant.actor, input)),
    list: tenantQuery
      .input(PublicationList)
      .query(({ ctx, input }) => publicationService.list(ctx.tenant.actor, input)),
    evidence: tenantQuery
      .input(PublicationEvidence)
      .query(({ ctx, input }) => publicationService.evidence(ctx.tenant.actor, input)),
    reconcile: tenantMutation
      .input(ReconcileCommand)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) => publicationService.reconcile(ctx.tenant.actor, input, tx)),
      ),
    deleteRemote: tenantMutation
      .input(PublicationDeleteRemote)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx, 72), (tx) =>
          publicationService.deleteRemote(ctx.tenant.actor, input, tx),
        ),
      ),
  }),
});
