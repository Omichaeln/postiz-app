import { z } from 'zod';
import type { ToolDefinition } from '../tool-registry';
import { NOT_AVAILABLE_YET } from './services';
import type { ToolContext } from '../tool-registry';

/**
 * Spec 12.4 metrics.query, voice.clusters, recommendations.create and experiments.proposeDesign. The definitions
 * (schemas, actions, effects) are unchanged from their Phase 4 placeholders; the body delegates to whatever
 * intelligence source the composition root registered (registerIntelligenceToolSource), so this code names no
 * module. Until a source is registered every call is authorised like any other and then denied with
 * tool_not_available_yet, exactly as before.
 */
const str = (maxLength: number) => ({ type: 'string', maxLength });

const availability = (ctx: Pick<ToolContext, 'services' | 'run'>) =>
  ctx.services.intelligence ? null : NOT_AVAILABLE_YET;

/** The source is present when `availability` passed; the dispatcher checks it before `run`. */
const sourceOf = (ctx: ToolContext) => {
  const source = ctx.services.intelligence;
  if (!source) throw new Error('intelligence tool source missing after availability check');
  return source;
};

const MetricsQueryInput = z
  .object({
    metricKeys: z.array(z.string().max(80)).min(1).max(20),
    from: z.string().datetime(),
    to: z.string().datetime(),
    channelConnectionIds: z.array(z.string()).max(50).default([]),
  })
  .strict();
const MetricsQueryOutput = z.object({
  series: z.array(
    z.object({
      metricKey: z.string(),
      points: z.array(z.object({ at: z.string(), value: z.number().nullable(), complete: z.boolean() })),
    }),
  ),
});

/** metrics.query: read, insight.read. Snapshots with freshness and completeness; missing is never zero. */
export const metricsQuery: ToolDefinition<
  z.infer<typeof MetricsQueryInput>,
  z.infer<typeof MetricsQueryOutput>
> = {
  name: 'metrics.query',
  description: 'Queries normalised metric snapshots for the brand (freshness and provenance included).',
  input: MetricsQueryInput,
  inputSchema: {
    type: 'object',
    properties: {
      metricKeys: { type: 'array', minItems: 1, maxItems: 20, items: str(80) },
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      channelConnectionIds: { type: 'array', items: { type: 'string' } },
    },
    required: ['metricKeys', 'from', 'to'],
    additionalProperties: false,
  },
  output: MetricsQueryOutput,
  action: 'insight.read',
  effect: 'read',
  availability,
  run: (input, ctx) => sourceOf(ctx).metricsQuery(ctx.actor, { brandId: ctx.run.brandId, ...input }, ctx.tx),
};

const VoiceClustersInput = z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict();
const VoiceClustersOutput = z.object({
  clusters: z.array(
    z.object({ id: z.string(), label: z.string(), size: z.number().int(), examples: z.array(z.string()) }),
  ),
});

/** voice.clusters: read, insight.read. Recurring questions and themes of the brand (no author identities). */
export const voiceClusters: ToolDefinition<
  z.infer<typeof VoiceClustersInput>,
  z.infer<typeof VoiceClustersOutput>
> = {
  name: 'voice.clusters',
  description: 'Lists customer-voice clusters (recurring questions and themes) for the brand.',
  input: VoiceClustersInput,
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
    additionalProperties: false,
  },
  output: VoiceClustersOutput,
  action: 'insight.read',
  effect: 'read',
  availability,
  run: (input, ctx) =>
    sourceOf(ctx).voiceClusters(ctx.actor, { brandId: ctx.run.brandId, limit: input.limit }, ctx.tx),
};

const RecommendationsCreateInput = z
  .object({
    title: z.string().min(1).max(200),
    rationale: z.string().max(4000),
    evidenceRefs: z.array(z.string().max(200)).max(50).default([]),
    suggestedAction: z.enum(['brief', 'variant', 'experiment', 'playbook_entry']),
  })
  .strict();
const RecommendationsCreateOutput = z.object({
  recommendationId: z.string(),
  state: z.literal('proposed'),
});

/** recommendations.create: propose, insight.read. A proposal for a person; it changes nothing by itself. */
export const recommendationsCreate: ToolDefinition<
  z.infer<typeof RecommendationsCreateInput>,
  z.infer<typeof RecommendationsCreateOutput>
> = {
  name: 'recommendations.create',
  description: 'Creates a recommendation with evidence for a person to accept or dismiss; proposes only.',
  input: RecommendationsCreateInput,
  inputSchema: {
    type: 'object',
    properties: {
      title: str(200),
      rationale: str(4000),
      evidenceRefs: { type: 'array', items: str(200) },
      suggestedAction: { type: 'string', enum: ['brief', 'variant', 'experiment', 'playbook_entry'] },
    },
    required: ['title', 'rationale', 'suggestedAction'],
    additionalProperties: false,
  },
  output: RecommendationsCreateOutput,
  action: 'insight.read',
  effect: 'propose',
  availability,
  async run(input, ctx) {
    const created = await sourceOf(ctx).recommendationsCreate(
      ctx.actor,
      { brandId: ctx.run.brandId, runId: ctx.run.runId, ...input },
      ctx.tx,
    );
    return { recommendationId: created.recommendationId, state: 'proposed' as const };
  },
};

const ProposeDesignInput = z
  .object({
    recommendationId: z.string().optional(),
    hypothesis: z.string().max(2000),
    primaryMetricKey: z.string().max(80),
    variants: z
      .array(z.object({ key: z.string().max(40), description: z.string().max(1000) }))
      .min(2)
      .max(6),
  })
  .strict();
const ProposeDesignOutput = z.object({ experimentId: z.string(), state: z.literal('proposed') });

/** experiments.proposeDesign: propose, experiment.manage. A designed (not pre-registered) experiment draft. */
export const experimentsProposeDesign: ToolDefinition<
  z.infer<typeof ProposeDesignInput>,
  z.infer<typeof ProposeDesignOutput>
> = {
  name: 'experiments.proposeDesign',
  description: 'Proposes a pre-registration draft for an experiment; an analyst approves it.',
  input: ProposeDesignInput,
  inputSchema: {
    type: 'object',
    properties: {
      recommendationId: { type: 'string' },
      hypothesis: str(2000),
      primaryMetricKey: str(80),
      variants: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        items: {
          type: 'object',
          properties: { key: str(40), description: str(1000) },
          required: ['key', 'description'],
        },
      },
    },
    required: ['hypothesis', 'primaryMetricKey', 'variants'],
    additionalProperties: false,
  },
  output: ProposeDesignOutput,
  action: 'experiment.manage',
  effect: 'propose',
  availability,
  async run(input, ctx) {
    const created = await sourceOf(ctx).experimentsProposeDesign(
      ctx.actor,
      { brandId: ctx.run.brandId, runId: ctx.run.runId, autonomyMode: ctx.run.policy.autonomyMode, ...input },
      ctx.tx,
    );
    return { experimentId: created.experimentId, state: 'proposed' as const };
  },
};
