import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../tool-registry';
import { NOT_AVAILABLE_YET } from './services';

/**
 * Spec 12.4 content.createBrief and content.draftCopy (effect draft). The body delegates to the content source the
 * composition root registered (registerContentToolSource), so this code names no module. Until a source is
 * registered every call is authorised like any other and then denied with tool_not_available_yet.
 */
const str = (maxLength: number) => ({ type: 'string', maxLength });

const availability = (ctx: Pick<ToolContext, 'services' | 'run'>) =>
  ctx.services.content ? null : NOT_AVAILABLE_YET;

/** The source is present when `availability` passed; the dispatcher checks it before `run`. */
const sourceOf = (ctx: ToolContext) => {
  const source = ctx.services.content;
  if (!source) throw new Error('content tool source missing after availability check');
  return source;
};

export const CreateBriefInput = z
  .object({
    campaignId: z.string().optional(),
    audience: z.string().min(1).max(1000),
    message: z.string().min(1).max(2000),
    offerFactIds: z.array(z.string()).max(20).default([]),
    channelConnectionIds: z.array(z.string()).max(20).default([]),
    constraints: z.array(z.string().max(300)).max(20).default([]),
  })
  .strict();
const CreateBriefOutput = z.object({ briefId: z.string(), state: z.literal('draft') });

/** content.createBrief: draft, content.plan. A draft brief (audience, message, offer facts, channels) for a person. */
export const contentCreateBrief: ToolDefinition<
  z.infer<typeof CreateBriefInput>,
  z.infer<typeof CreateBriefOutput>
> = {
  name: 'content.createBrief',
  description:
    'Creates a draft brief for the brand (audience, message, offer fact ids, planned channel connection ids, constraints), optionally inside a campaign.',
  input: CreateBriefInput,
  inputSchema: {
    type: 'object',
    properties: {
      campaignId: { type: 'string' },
      audience: { type: 'string', minLength: 1, maxLength: 1000 },
      message: { type: 'string', minLength: 1, maxLength: 2000 },
      offerFactIds: { type: 'array', maxItems: 20, items: { type: 'string' } },
      channelConnectionIds: { type: 'array', maxItems: 20, items: { type: 'string' } },
      constraints: { type: 'array', maxItems: 20, items: str(300) },
    },
    required: ['audience', 'message'],
    additionalProperties: false,
  },
  output: CreateBriefOutput,
  action: 'content.plan',
  effect: 'draft',
  availability,
  async run(input, ctx) {
    const created = await sourceOf(ctx).createBrief(
      ctx.actor,
      {
        brandId: ctx.run.brandId,
        runId: ctx.run.runId,
        autonomyMode: ctx.run.policy.autonomyMode,
        ...input,
      },
      ctx.tx,
    );
    return { briefId: created.briefId, state: 'draft' as const };
  },
};

export const DraftCopyInput = z
  .object({
    briefId: z.string(),
    variants: z
      .array(
        z
          .object({
            text: z.string().min(1).max(5000),
            factIds: z.array(z.string()).max(50).default([]),
            rationale: z.string().max(1000),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
const DraftCopyOutput = z.object({
  drafts: z.array(
    z.object({ contentPackageId: z.string(), contentRevisionId: z.string(), contentHash: z.string() }),
  ),
  state: z.literal('draft'),
});

/**
 * content.draftCopy: draft, content.edit. Each caption variant (text, cited fact ids, rationale) becomes a draft
 * content package whose revision 1 carries the copy, under the brief; cited facts must be approved and effective.
 * Nothing is sent for review or published.
 */
export const contentDraftCopy: ToolDefinition<
  z.infer<typeof DraftCopyInput>,
  z.infer<typeof DraftCopyOutput>
> = {
  name: 'content.draftCopy',
  description:
    'Drafts caption variants for a brief (text, cited approved fact ids, rationale). Each variant becomes a draft content revision; never reviews or publishes.',
  input: DraftCopyInput,
  inputSchema: {
    type: 'object',
    properties: {
      briefId: { type: 'string' },
      variants: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 5000 },
            factIds: { type: 'array', maxItems: 50, items: { type: 'string' } },
            rationale: str(1000),
          },
          required: ['text', 'rationale'],
          additionalProperties: false,
        },
      },
    },
    required: ['briefId', 'variants'],
    additionalProperties: false,
  },
  output: DraftCopyOutput,
  action: 'content.edit',
  effect: 'draft',
  resource: (input, run) => ({
    type: 'brief',
    tenantId: run.tenantId,
    brandId: run.brandId,
    id: input.briefId,
  }),
  availability,
  async run(input, ctx) {
    const drafted = await sourceOf(ctx).draftCopy(
      ctx.actor,
      {
        brandId: ctx.run.brandId,
        runId: ctx.run.runId,
        autonomyMode: ctx.run.policy.autonomyMode,
        ...input,
      },
      ctx.tx,
    );
    return { drafts: drafted.drafts, state: 'draft' as const };
  },
};
