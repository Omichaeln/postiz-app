import { ExternalLinkCreate, ExternalLinkRevoke } from '@oremedia/contracts/access';
import { MandateCreate } from '@oremedia/contracts/publishing';
import {
  ApprovalGet,
  MandateGet,
  MandatePause,
  MandateRevoke,
  ReviewDecisionSubmit,
  ReviewInboxList,
  ReviewRequestCreate,
  ReviewRequestGet,
} from '@oremedia/contracts/review';
import { idempotent } from '@oremedia/module-operations';
import { reviewService } from '@oremedia/module-review';
import { router, tenantMutation, tenantQuery, type MutationCtx } from '../trpc';

const mutationCtx = (ctx: MutationCtx) => ({
  idempotency: ctx.idempotency,
  actor: { kind: ctx.tenant.actorRef.kind, id: ctx.tenant.actorRef.id },
});

/** Spec 7.5 review router (spec 13: requests with frozen manifests, decisions, inbox, external links, mandates). */
export const reviewRouter = router({
  requests: router({
    create: tenantMutation
      .input(ReviewRequestCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => reviewService.requests.create(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(ReviewRequestGet)
      .query(({ ctx, input }) => reviewService.requests.get(ctx.tenant.actor, input)),
  }),

  decisions: router({
    /** Spec 5.6: the decision records the verified email and the hashed origin the context carries. */
    submit: tenantMutation.input(ReviewDecisionSubmit).mutation(({ ctx, input }) =>
      idempotent(mutationCtx(ctx), (tx) =>
        reviewService.decisions.submit(ctx.tenant.actor, input, tx, {
          ipHash: ctx.ipHash,
          userAgentHash: ctx.userAgentHash,
        }),
      ),
    ),
  }),

  inbox: router({
    list: tenantQuery
      .input(ReviewInboxList)
      .query(({ ctx, input }) => reviewService.inbox.list(ctx.tenant.actor, input)),
  }),

  externalLinks: router({
    create: tenantMutation
      .input(ExternalLinkCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => reviewService.externalLinks.create(ctx.tenant.actor, input, tx)),
      ),
    revoke: tenantMutation
      .input(ExternalLinkRevoke)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => reviewService.externalLinks.revoke(ctx.tenant.actor, input, tx)),
      ),
  }),

  approvals: router({
    get: tenantQuery
      .input(ApprovalGet)
      .query(({ ctx, input }) => reviewService.approvals.get(ctx.tenant.actor, input)),
  }),

  /** Spec 7.5 lists mandates under publishing; they live here with the release policy that evaluates them. */
  mandates: router({
    create: tenantMutation
      .input(MandateCreate)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => reviewService.mandates.create(ctx.tenant.actor, input, tx)),
      ),
    pause: tenantMutation
      .input(MandatePause)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => reviewService.mandates.pause(ctx.tenant.actor, input, tx)),
      ),
    revoke: tenantMutation
      .input(MandateRevoke)
      .mutation(({ ctx, input }) =>
        idempotent(mutationCtx(ctx), (tx) => reviewService.mandates.revoke(ctx.tenant.actor, input, tx)),
      ),
    get: tenantQuery
      .input(MandateGet)
      .query(({ ctx, input }) => reviewService.mandates.get(ctx.tenant.actor, input)),
  }),
});
