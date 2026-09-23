import { z } from 'zod';
import {
  ApiClientCreate,
  ApiClientRotate,
  BrandGrantSet,
  MemberInvite,
  MemberSetRole,
  ServicePrincipalCreate,
  ServicePrincipalRevoke,
} from '@oremedia/contracts/access';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { accessService } from '@oremedia/module-access';
import { idempotent } from '@oremedia/module-operations';
import { authedProcedure, router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx, ttlHours?: number) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
  ttlHours,
});

/** Spec 7.5 access router. */
export const accessRouter = router({
  me: tenantQuery.query(({ ctx }) => accessService.me(ctx.tenant.actor)),

  listCompanies: authedProcedure.query(({ ctx }) => {
    if (ctx.principal.kind !== 'user')
      throw new PolicyDeniedError('user_session_required', 'Only a user session has a portfolio');
    return accessService.listCompanies(ctx.principal.userId, ctx.correlationId);
  }),

  switchCompany: authedProcedure
    .input(z.object({ tenantId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.principal.kind !== 'user') throw new PolicyDeniedError('user_session_required');
      await accessService.switchCompany(
        ctx.principal.sessionId,
        ctx.principal.userId,
        input.tenantId,
        ctx.correlationId,
      );
      return { tenantId: input.tenantId };
    }),

  members: router({
    invite: tenantMutation
      .input(MemberInvite)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => accessService.inviteMember(ctx.tenant.actor, input, tx)),
      ),
    setRole: tenantMutation.input(MemberSetRole).mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), async (tx) => {
        await accessService.setRole(ctx.tenant.actor, input, tx);
        return { ok: true };
      }),
    ),
  }),

  brandGrants: router({
    set: tenantMutation
      .input(BrandGrantSet)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => accessService.setBrandGrant(ctx.tenant.actor, input, tx)),
      ),
  }),

  servicePrincipals: router({
    create: tenantMutation
      .input(ServicePrincipalCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          accessService.createServicePrincipal(ctx.tenant.actor, input, tx),
        ),
      ),
    revoke: tenantMutation.input(ServicePrincipalRevoke).mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), async (tx) => {
        await accessService.revokeServicePrincipal(ctx.tenant.actor, input, tx);
        return { ok: true };
      }),
    ),
  }),

  apiClients: router({
    create: tenantMutation
      .input(ApiClientCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => accessService.createApiClient(ctx.tenant.actor, input, tx)),
      ),
    rotate: tenantMutation
      .input(ApiClientRotate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => accessService.rotateApiClient(ctx.tenant.actor, input, tx)),
      ),
  }),
});
