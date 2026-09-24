import { z } from 'zod';
import { Finding, Operation, OperationBatch } from '@oremedia/contracts/creative';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import type { Tx } from '@oremedia/db';
import { creativeService } from '@oremedia/module-creative';
import { ProposalRequest, type ToolDefinition } from '../tool-registry';

const ProposeInput = z
  .object({
    documentId: z.string(),
    baseRevisionId: z.string(),
    operations: z.array(Operation).min(1).max(100),
    summary: z.string().min(1).max(500),
  })
  .strict();

const ProposeOutput = z.object({
  status: z.literal('rejected'),
  findings: z.array(Finding),
});

const OPERATION_INPUT_SCHEMA = {
  type: 'object',
  description: 'One creative operation (spec 11.3), discriminated by "op".',
  properties: {
    op: {
      type: 'string',
      enum: [
        'insertElement',
        'removeElement',
        'setText',
        'setStyle',
        'replaceAsset',
        'moveElement',
        'resizeElement',
        'reorderElement',
        'setCrop',
        'applyTemplate',
        'addPage',
        'createFormatVariant',
        'setLock',
      ],
    },
    pageId: { type: 'string' },
    elementId: { type: 'string' },
  },
  required: ['op'],
};

/** The payload a proposal carries until a person decides; applied by recordDecision on accept. */
export const CreativeProposalPayload = z.object({
  documentId: z.string(),
  baseRevisionId: z.string(),
  operations: z.array(Operation).min(1).max(100),
  summary: z.string(),
  contentHash: z.string(),
  findings: z.array(Finding),
});
export type CreativeProposalPayload = z.infer<typeof CreativeProposalPayload>;

/**
 * creative.proposeOperations: propose, creative.edit. The creative module evaluates the batch as a dry run (guards,
 * asset authorisation, brand validation); a clean batch becomes a proposal a person accepts, rejects or modifies.
 * Blocking findings are returned to the model to correct; nothing is written either way.
 */
export const creativeProposeOperations: ToolDefinition<
  z.infer<typeof ProposeInput>,
  z.infer<typeof ProposeOutput>
> = {
  name: 'creative.proposeOperations',
  description:
    'Proposes an operation batch against a creative document revision. Returns blocking findings to fix, or hands the proposal to a person for a decision.',
  input: ProposeInput,
  inputSchema: {
    type: 'object',
    properties: {
      documentId: { type: 'string' },
      baseRevisionId: { type: 'string' },
      operations: { type: 'array', minItems: 1, maxItems: 100, items: OPERATION_INPUT_SCHEMA },
      summary: { type: 'string', minLength: 1, maxLength: 500 },
    },
    required: ['documentId', 'baseRevisionId', 'operations', 'summary'],
    additionalProperties: false,
  },
  output: ProposeOutput,
  action: 'creative.edit',
  effect: 'propose',
  resource: (input, run) => ({
    type: 'creative_document',
    tenantId: run.tenantId,
    brandId: run.brandId,
    id: input.documentId,
  }),
  async run(input, ctx) {
    const proposed = await ctx.services.creative.operations.propose(
      ctx.actor,
      { ...input, origin: 'agent', agentRunId: ctx.run.runId },
      ctx.tx,
      { autonomyMode: ctx.run.policy.autonomyMode },
    );
    if (proposed.blocking) return { status: 'rejected', findings: proposed.findings };
    const payload: CreativeProposalPayload = {
      documentId: input.documentId,
      baseRevisionId: proposed.baseRevisionId,
      operations: input.operations,
      summary: input.summary,
      contentHash: proposed.contentHash,
      findings: proposed.findings,
    };
    return new ProposalRequest(proposed.contentHash, payload);
  },
};

const RenderInput = z
  .object({
    documentId: z.string(),
    revisionId: z.string(),
    formatKeys: z.array(z.string().min(1).max(40)).min(1).max(20),
  })
  .strict();

/** creative.requestRender: draft, creative.render. A render job the render worker picks up; nothing is published. */
export const creativeRequestRender: ToolDefinition<
  z.infer<typeof RenderInput>,
  { renderJobId: string; state: 'pending' }
> = {
  name: 'creative.requestRender',
  description: 'Requests renders of a document revision in the given format keys. Returns the render job id.',
  input: RenderInput,
  inputSchema: {
    type: 'object',
    properties: {
      documentId: { type: 'string' },
      revisionId: { type: 'string' },
      formatKeys: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
    },
    required: ['documentId', 'revisionId', 'formatKeys'],
    additionalProperties: false,
  },
  output: z.object({ renderJobId: z.string(), state: z.literal('pending') }),
  action: 'creative.render',
  effect: 'draft',
  resource: (input, run) => ({
    type: 'creative_document',
    tenantId: run.tenantId,
    brandId: run.brandId,
    id: input.documentId,
  }),
  async run(input, ctx) {
    const job = await ctx.services.creative.renders.request(ctx.actor, input, ctx.tx, {
      autonomyMode: ctx.run.policy.autonomyMode,
    });
    return { renderJobId: job.renderJobId, state: job.state };
  },
};

/**
 * Applies an accepted proposal (the run's principal, origin agent) or a person's modified batch (origin user).
 * Used by recordDecision and approveProposal; the creative module re-runs every guard and validation.
 */
export async function applyProposalBatch(
  actor: ResolvedActor,
  batch: z.infer<typeof OperationBatch> & { documentId: string },
  tx: Tx,
  opts: { autonomyMode?: AutonomyMode } = {},
) {
  const parsed = OperationBatch.extend({ documentId: z.string() }).parse(batch);
  return creativeService.operations.apply(actor, parsed, tx, opts);
}
