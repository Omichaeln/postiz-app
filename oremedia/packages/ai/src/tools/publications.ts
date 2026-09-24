import { z } from 'zod';
import { hashCanonical } from '@oremedia/domain/hash';
import {
  PersonCompletedProposal,
  ProposalRequest,
  type ToolContext,
  type ToolDefinition,
} from '../tool-registry';
import { NOT_AVAILABLE_YET } from './services';

/**
 * Spec 12.4 publications.proposeSchedule, backed by the publishing source the composition root registered
 * (registerPublishingToolSource). Until a source is registered every call is authorised and then denied with
 * tool_not_available_yet.
 */
const availability = (ctx: Pick<ToolContext, 'services' | 'run'>) =>
  ctx.services.publishing ? null : NOT_AVAILABLE_YET;
const sourceOf = (ctx: ToolContext) => {
  const source = ctx.services.publishing;
  if (!source) throw new Error('publishing tool source missing after availability check');
  return source;
};

export const ProposeScheduleInput = z
  .object({
    contentRevisionId: z.string(),
    channelConnectionIds: z.array(z.string()).min(1).max(20),
    proposedAt: z.string().datetime(),
    rationale: z.string().max(1000).optional(),
  })
  .strict();

/**
 * The pending proposal (tool_invocations.proposal_payload): the publications.schedule commands a person submits with
 * a valid approval (or the release policy completes under a mandate, spec 13.4). Accepting it applies nothing.
 */
export const ScheduleProposalPayload = PersonCompletedProposal.extend({
  completion: z.literal('person'),
  command: z.literal('publications.schedule'),
  contentRevisionId: z.string(),
  entries: z
    .array(
      z.object({ channelConnectionId: z.string(), channelVariantId: z.string(), scheduledFor: z.string() }),
    )
    .min(1),
  rationale: z.string().nullable(),
}).strict();
export type ScheduleProposalPayload = z.infer<typeof ScheduleProposalPayload>;

/**
 * publications.proposeSchedule: propose, publication.schedule. Contract: creates a *pending proposal* (content
 * revision + channel connections + proposed slot) that a person with publication.schedule completes through
 * publications.schedule with a valid approval, or that the deterministic release policy completes under a managed
 * autopublish mandate (spec 13.4). The model never publishes and never schedules: the publishing source only
 * checks the slot and resolves each channel's variant; the result is always proposal_requires_user.
 */
export const publicationsProposeSchedule: ToolDefinition<
  z.infer<typeof ProposeScheduleInput>,
  ScheduleProposalPayload
> = {
  name: 'publications.proposeSchedule',
  description:
    'Proposes a publication slot for an approved content revision on given channel connections. Creates a pending proposal only; a person or the release policy completes it.',
  input: ProposeScheduleInput,
  inputSchema: {
    type: 'object',
    properties: {
      contentRevisionId: { type: 'string' },
      channelConnectionIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
      proposedAt: { type: 'string', format: 'date-time' },
      rationale: { type: 'string', maxLength: 1000 },
    },
    required: ['contentRevisionId', 'channelConnectionIds', 'proposedAt'],
    additionalProperties: false,
  },
  // Never returned as an `ok` output: every successful call is a proposal carrying this payload.
  output: ScheduleProposalPayload,
  action: 'publication.schedule',
  effect: 'propose',
  resource: (input, run) => ({
    type: 'content_revision',
    tenantId: run.tenantId,
    brandId: run.brandId,
    id: input.contentRevisionId,
  }),
  availability,
  async run(input, ctx) {
    const checked = await sourceOf(ctx).proposeSchedule(
      ctx.actor,
      {
        brandId: ctx.run.brandId,
        runId: ctx.run.runId,
        autonomyMode: ctx.run.policy.autonomyMode,
        contentRevisionId: input.contentRevisionId,
        channelConnectionIds: input.channelConnectionIds,
        proposedAt: input.proposedAt,
      },
      ctx.tx,
    );
    const payload = ScheduleProposalPayload.parse({
      completion: 'person',
      command: 'publications.schedule',
      contentRevisionId: input.contentRevisionId,
      entries: checked.entries,
      rationale: input.rationale ?? null,
    });
    return new ProposalRequest(hashCanonical(payload), payload);
  },
};
