import {
  CommentAdd,
  CommentList,
  CommentResolve,
  DocumentCreate,
  DocumentGet,
  OperationsApply,
  OperationsPropose,
  RenderGet,
  RenderRequest,
  RevisionGet,
  RevisionList,
  TemplateApprove,
  TemplateCreate,
  TemplateGet,
  TemplateList,
  TemplateVersionCreate,
} from '@oremedia/contracts/creative';
import { creativeService } from '@oremedia/module-creative';
import { idempotent } from '@oremedia/module-operations';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 creative router (spec 11: documents, revisions, the operation engine, renders, comments, templates). */
export const creativeRouter = router({
  documents: router({
    create: tenantMutation
      .input(DocumentCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.documents.create(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(DocumentGet)
      .query(({ ctx, input }) => creativeService.documents.get(ctx.tenant.actor, input)),
  }),

  revisions: router({
    list: tenantQuery
      .input(RevisionList)
      .query(({ ctx, input }) => creativeService.revisions.list(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(RevisionGet)
      .query(({ ctx, input }) => creativeService.revisions.get(ctx.tenant.actor, input)),
  }),

  operations: router({
    /** Spec 7.5 names this operations.apply; tRPC reserves `apply` as a router key, so the procedure is applyBatch. */
    applyBatch: tenantMutation
      .input(OperationsApply)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.operations.apply(ctx.tenant.actor, input, tx)),
      ),
    /** Agent preview (spec 11.4): the same guards and validation as a dry run; nothing is committed. */
    propose: tenantMutation
      .input(OperationsPropose)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.operations.propose(ctx.tenant.actor, input, tx)),
      ),
  }),

  renders: router({
    request: tenantMutation
      .input(RenderRequest)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.renders.request(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(RenderGet)
      .query(({ ctx, input }) => creativeService.renders.get(ctx.tenant.actor, input)),
  }),

  comments: router({
    add: tenantMutation
      .input(CommentAdd)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.comments.add(ctx.tenant.actor, input, tx)),
      ),
    resolve: tenantMutation
      .input(CommentResolve)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.comments.resolve(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(CommentList)
      .query(({ ctx, input }) => creativeService.comments.list(ctx.tenant.actor, input)),
  }),

  templates: router({
    create: tenantMutation
      .input(TemplateCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.templates.create(ctx.tenant.actor, input, tx)),
      ),
    createVersion: tenantMutation
      .input(TemplateVersionCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) =>
          creativeService.templates.createVersion(ctx.tenant.actor, input, tx),
        ),
      ),
    approve: tenantMutation
      .input(TemplateApprove)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => creativeService.templates.approve(ctx.tenant.actor, input, tx)),
      ),
    list: tenantQuery
      .input(TemplateList)
      .query(({ ctx, input }) => creativeService.templates.list(ctx.tenant.actor, input)),
    get: tenantQuery
      .input(TemplateGet)
      .query(({ ctx, input }) => creativeService.templates.get(ctx.tenant.actor, input)),
  }),
});
