import { z } from 'zod';
import { BrandCreate } from '@oremedia/contracts/brand';
import { brandService } from '@oremedia/module-brand';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 brand router (Phase 1 subset: create, list, get; versions/facts/objectives arrive in Phase 2). */
export const brandRouter = router({
  create: tenantMutation
    .input(BrandCreate)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => brandService.create(ctx.tenant.actor, input, tx)),
    ),
  list: tenantQuery.query(({ ctx }) => brandService.list(ctx.tenant.actor)),
  get: tenantQuery
    .input(z.object({ brandId: z.string() }))
    .query(({ ctx, input }) => brandService.get(ctx.tenant.actor, input.brandId)),
});
