import { z } from 'zod';
import { Finding, type CreativeDocumentV1, type Element } from '@oremedia/contracts/creative';
import { ToolDeniedError } from '../tool-dispatcher';
import type { ToolContext, ToolDefinition } from '../tool-registry';
import { NOT_AVAILABLE_YET } from './services';

const ReviewInput = z.object({ documentId: z.string(), revisionId: z.string() }).strict();
const ReviewOutput = z.object({
  revisionId: z.string(),
  contentHash: z.string(),
  brandVersionId: z.string(),
  findings: z.array(Finding),
  blocking: z.boolean(),
});

/** The first element an agent may address with an identity operation: not protected, not a logo (spec 11.4 guards). */
function reviewableElement(
  doc: CreativeDocumentV1,
): { pageId: string; element: Element; index: number } | null {
  for (const page of doc.pages) {
    for (const [index, element] of page.elements.entries()) {
      if (!element.protected && element.type !== 'logo') return { pageId: page.id, element, index };
    }
  }
  return null;
}

/**
 * review.runBrandReview: read, creative.read. Deterministic brand validation of an exact revision through the
 * creative module's dry-run evaluation (an identity reorder of one unprotected element changes nothing and yields
 * the pinned-brand-version findings of validateAgainstBrand). Render-time checks (packages/editor/src/checks.ts)
 * need measured scene metrics and run on exports, not here. Only the current head revision can be evaluated; an
 * older revision is refused as stale.
 */
export const reviewRunBrandReview: ToolDefinition<
  z.infer<typeof ReviewInput>,
  z.infer<typeof ReviewOutput>
> = {
  name: 'review.runBrandReview',
  description:
    'Runs the deterministic brand checks (tokens, logo rules, type sizes, contrast, fact references, prohibited phrases) on a revision and returns findings by element id.',
  input: ReviewInput,
  inputSchema: {
    type: 'object',
    properties: { documentId: { type: 'string' }, revisionId: { type: 'string' } },
    required: ['documentId', 'revisionId'],
    additionalProperties: false,
  },
  output: ReviewOutput,
  action: 'creative.read',
  effect: 'read',
  resource: (input, run) => ({
    type: 'creative_document',
    tenantId: run.tenantId,
    brandId: run.brandId,
    id: input.documentId,
  }),
  async run(input, ctx) {
    const revision = await ctx.services.creative.revisions.get(ctx.actor, input, ctx.tx);
    const target = reviewableElement(revision.snapshot);
    if (!target) throw new ToolDeniedError('no_reviewable_element');
    const proposed = await ctx.services.creative.operations.propose(
      ctx.actor,
      {
        documentId: input.documentId,
        baseRevisionId: revision.id,
        operations: [
          {
            op: 'reorderElement',
            pageId: target.pageId,
            elementId: target.element.id,
            toIndex: target.index,
          },
        ],
        summary: 'brand review (no change)',
        origin: 'agent',
        agentRunId: ctx.run.runId,
      },
      ctx.tx,
      { autonomyMode: ctx.run.policy.autonomyMode },
    );
    return {
      revisionId: revision.id,
      contentHash: revision.contentHash,
      brandVersionId: revision.brandVersionId,
      findings: proposed.findings,
      blocking: proposed.blocking,
    };
  },
};

/** review.request is backed by the review source the composition root registered (registerReviewToolSource). */
const reviewSourceAvailability = (ctx: Pick<ToolContext, 'services' | 'run'>) =>
  ctx.services.review ? null : NOT_AVAILABLE_YET;
const reviewSourceOf = (ctx: ToolContext) => {
  const source = ctx.services.review;
  if (!source) throw new Error('review tool source missing after availability check');
  return source;
};

export const RequestReviewInput = z
  .object({
    contentRevisionId: z.string(),
    reviewerUserIds: z.array(z.string()).max(20).default([]),
    dueAt: z.string().datetime().optional(),
    /** The publication timing the reviewer approves (frozen into the manifest and the approval binding). */
    timing: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('exact'), at: z.string().datetime() }).strict(),
      z
        .object({ kind: z.literal('window'), from: z.string().datetime(), to: z.string().datetime() })
        .strict(),
    ]),
  })
  .strict();
const RequestReviewOutput = z.object({
  reviewRequestId: z.string(),
  manifestHash: z.string(),
  state: z.literal('open'),
});

/**
 * review.request: propose, review.request. Opens a review request on a content revision of the brand (the manifest
 * of exactly what the reviewer sees is frozen; the revision moves to in_review). A person with review.decide
 * decides; the agent never approves (review.decide is agent_never).
 */
export const reviewRequest: ToolDefinition<
  z.infer<typeof RequestReviewInput>,
  z.infer<typeof RequestReviewOutput>
> = {
  name: 'review.request',
  description:
    'Requests a review of a content revision (with channel variants) for a publication timing; a person with review.decide approves or requests changes.',
  input: RequestReviewInput,
  inputSchema: {
    type: 'object',
    properties: {
      contentRevisionId: { type: 'string' },
      reviewerUserIds: { type: 'array', maxItems: 20, items: { type: 'string' } },
      dueAt: { type: 'string', format: 'date-time' },
      timing: {
        type: 'object',
        description:
          'Either {"kind":"exact","at":<date-time>} or {"kind":"window","from":<date-time>,"to":<date-time>}.',
        properties: {
          kind: { type: 'string', enum: ['exact', 'window'] },
          at: { type: 'string', format: 'date-time' },
          from: { type: 'string', format: 'date-time' },
          to: { type: 'string', format: 'date-time' },
        },
        required: ['kind'],
      },
    },
    required: ['contentRevisionId', 'timing'],
    additionalProperties: false,
  },
  output: RequestReviewOutput,
  action: 'review.request',
  effect: 'propose',
  resource: (input, run) => ({
    type: 'content_revision',
    tenantId: run.tenantId,
    brandId: run.brandId,
    id: input.contentRevisionId,
  }),
  availability: reviewSourceAvailability,
  async run(input, ctx) {
    const created = await reviewSourceOf(ctx).requestReview(
      ctx.actor,
      {
        brandId: ctx.run.brandId,
        runId: ctx.run.runId,
        autonomyMode: ctx.run.policy.autonomyMode,
        contentRevisionId: input.contentRevisionId,
        assigneeUserIds: input.reviewerUserIds,
        timing: input.timing,
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      },
      ctx.tx,
    );
    return { ...created, state: 'open' as const };
  },
};
