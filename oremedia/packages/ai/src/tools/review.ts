import { z } from 'zod';
import { Finding, type CreativeDocumentV1, type Element } from '@oremedia/contracts/creative';
import { ToolDeniedError } from '../tool-dispatcher';
import type { ToolDefinition } from '../tool-registry';

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
