import {
  SkillBindingSet,
  SkillExport,
  SkillGet,
  SkillImport,
  SkillList,
  SkillVersionCreate,
  SkillVersionEvaluate,
  SkillVersionPublish,
} from '@oremedia/contracts/skills';
import { skillsService } from '@oremedia/module-skills';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 skills router (spec 10: registry, lifecycle, bindings and the Agent Skills package round-trip). */
export const skillsRouter = router({
  list: tenantQuery.input(SkillList).query(({ ctx, input }) => skillsService.list(ctx.tenant.actor, input)),
  get: tenantQuery.input(SkillGet).query(({ ctx, input }) => skillsService.get(ctx.tenant.actor, input)),

  versions: router({
    create: tenantMutation
      .input(SkillVersionCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => skillsService.versions.create(ctx.tenant.actor, input, tx)),
      ),
    evaluate: tenantMutation
      .input(SkillVersionEvaluate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => skillsService.versions.evaluate(ctx.tenant.actor, input, tx)),
      ),
    publish: tenantMutation
      .input(SkillVersionPublish)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => skillsService.versions.publish(ctx.tenant.actor, input, tx)),
      ),
  }),

  bindings: router({
    set: tenantMutation
      .input(SkillBindingSet)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => skillsService.bindings.set(ctx.tenant.actor, input, tx)),
      ),
  }),

  import: tenantMutation
    .input(SkillImport)
    .mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) => skillsService.import(ctx.tenant.actor, input, tx)),
    ),
  export: tenantQuery
    .input(SkillExport)
    .query(({ ctx, input }) => skillsService.export(ctx.tenant.actor, input)),
});
