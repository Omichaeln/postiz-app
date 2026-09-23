import { z } from 'zod';
import { AuditQuery, DeletionRequestCreate, KillSwitchScope } from '@oremedia/contracts/operations';
import { PageRequest } from '@oremedia/contracts/pagination';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { deletion, featureFlag, idempotent, killSwitch, audit } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 operations router: audit.query, deletion.request, plus flags and kill switches (22.1, 23.3). */
export const operationsRouter = router({
  audit: router({
    query: tenantQuery
      .input(z.object({ query: AuditQuery, page: PageRequest }))
      .query(async ({ ctx, input }) => {
        await policy.assert(ctx.tenant.actor, 'audit.read', {
          type: 'tenant',
          tenantId: ctx.tenant.context.tenantId,
          id: ctx.tenant.context.tenantId,
        });
        return audit.query(input.query, input.page);
      }),
  }),
  flags: router({
    snapshot: tenantQuery.query(({ ctx }) => featureFlag.snapshot(ctx.tenant.context.tenantId)),
  }),
  killSwitch: router({
    get: tenantQuery
      .input(z.object({ scope: KillSwitchScope, brandId: z.string().optional() }))
      .query(async ({ ctx, input }) => {
        await policy.assert(ctx.tenant.actor, 'audit.read', {
          type: 'tenant',
          tenantId: ctx.tenant.context.tenantId,
          id: ctx.tenant.context.tenantId,
        });
        if (input.brandId) await brandService.assertExist([input.brandId]);
        return { engaged: await killSwitch.isOn(input.scope, input.brandId) };
      }),
    set: tenantMutation
      .input(
        z.object({
          scope: KillSwitchScope,
          brandId: z.string().nullable(),
          engaged: z.boolean(),
          reason: z.string().max(500).nullable(),
        }),
      )
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), async (tx) => {
          await policy.assert(
            ctx.tenant.actor,
            'billing.manage',
            { type: 'tenant', tenantId: ctx.tenant.context.tenantId, id: ctx.tenant.context.tenantId },
            {},
            tx,
          );
          if (ctx.tenant.actor.kind !== 'user') throw new PolicyDeniedError('agent_never');
          if (input.brandId) await brandService.assertExist([input.brandId], tx);
          await killSwitch.set(
            input.scope,
            input.brandId,
            input.engaged,
            input.reason,
            ctx.tenant.actorRef,
            tx,
          );
          return { ok: true };
        }),
      ),
  }),
  deletion: router({
    request: tenantMutation.input(DeletionRequestCreate).mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), async (tx) => {
        await policy.assert(
          ctx.tenant.actor,
          'billing.manage',
          { type: 'tenant', tenantId: ctx.tenant.context.tenantId, id: ctx.tenant.context.tenantId },
          {},
          tx,
        );
        // Subjects are validated by their owning module; brand is the Phase 1 subject, others are added with their modules.
        if (input.subjectType === 'brand') await brandService.assertExist([input.subjectId], tx);
        else
          throw new PolicyDeniedError(
            'subject_type_not_supported_yet',
            `Deletion of ${input.subjectType} is not available yet`,
          );
        return deletion.request(ctx.tenant.actorRef, input, tx);
      }),
    ),
  }),
});
