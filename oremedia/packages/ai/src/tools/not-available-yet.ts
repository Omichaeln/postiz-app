import { z } from 'zod';
import type { Action } from '@oremedia/contracts/policy';
import type { ToolEffect } from '@oremedia/contracts/agents';
import { ToolDeniedError } from '../tool-dispatcher';
import type { ToolDefinition } from '../tool-registry';

/**
 * Release 1 tools whose backing modules arrive in Phases 5-6 (content, review requests, measurement, intelligence,
 * experiments, publishing). They are registered now with their real schemas, actions and effects so allowlists,
 * policy and the prompt are stable; a call is authorised like any other and then denied with
 * tool_not_available_yet. None of them publishes: publications.proposeSchedule creates a *pending proposal* that a
 * person or a mandate completes (spec 12.4, 13.4).
 */
export const NOT_AVAILABLE_YET = 'tool_not_available_yet';

function pending<I, O>(def: {
  name: string;
  description: string;
  input: z.ZodType<I, z.ZodTypeDef, unknown>;
  inputSchema: Record<string, unknown>;
  output: z.ZodType<O, z.ZodTypeDef, unknown>;
  action: Action;
  effect: Exclude<ToolEffect, 'external'>;
}): ToolDefinition<I, O> {
  return {
    ...def,
    availability: () => NOT_AVAILABLE_YET,
    async run() {
      throw new ToolDeniedError(NOT_AVAILABLE_YET);
    },
  };
}

const str = (maxLength: number) => ({ type: 'string', maxLength });

export const metricsQuery = pending({
  name: 'metrics.query',
  description: 'Queries normalised metric snapshots for the brand (freshness and provenance included).',
  input: z
    .object({
      metricKeys: z.array(z.string().max(80)).min(1).max(20),
      from: z.string().datetime(),
      to: z.string().datetime(),
      channelConnectionIds: z.array(z.string()).max(50).default([]),
    })
    .strict(),
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
  output: z.object({
    series: z.array(
      z.object({
        metricKey: z.string(),
        points: z.array(z.object({ at: z.string(), value: z.number().nullable(), complete: z.boolean() })),
      }),
    ),
  }),
  action: 'insight.read',
  effect: 'read',
});

export const voiceClusters = pending({
  name: 'voice.clusters',
  description: 'Lists customer-voice clusters (recurring questions and themes) for the brand.',
  input: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
    additionalProperties: false,
  },
  output: z.object({
    clusters: z.array(
      z.object({ id: z.string(), label: z.string(), size: z.number().int(), examples: z.array(z.string()) }),
    ),
  }),
  action: 'insight.read',
  effect: 'read',
});

export const contentCreateBrief = pending({
  name: 'content.createBrief',
  description: 'Creates a draft brief (objective, audience, offer facts, channels, dates) inside a campaign.',
  input: z
    .object({
      campaignId: z.string().optional(),
      title: z.string().min(1).max(200),
      objective: z.string().max(2000),
      audienceKeys: z.array(z.string().max(80)).max(20).default([]),
      factIds: z.array(z.string()).max(50).default([]),
      channels: z.array(z.string().max(40)).max(20).default([]),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      campaignId: { type: 'string' },
      title: str(200),
      objective: str(2000),
      audienceKeys: { type: 'array', items: str(80) },
      factIds: { type: 'array', items: { type: 'string' } },
      channels: { type: 'array', items: str(40) },
    },
    required: ['title', 'objective'],
    additionalProperties: false,
  },
  output: z.object({ briefId: z.string(), state: z.literal('draft') }),
  action: 'content.plan',
  effect: 'draft',
});

export const contentDraftCopy = pending({
  name: 'content.draftCopy',
  description: 'Drafts caption variants for a brief with rationale and fact references; never publishes.',
  input: z
    .object({
      briefId: z.string(),
      variants: z
        .array(
          z.object({
            text: z.string().max(5000),
            factIds: z.array(z.string()).max(50),
            rationale: z.string().max(1000),
          }),
        )
        .min(1)
        .max(12),
    })
    .strict(),
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
            text: str(5000),
            factIds: { type: 'array', items: { type: 'string' } },
            rationale: str(1000),
          },
          required: ['text', 'factIds', 'rationale'],
        },
      },
    },
    required: ['briefId', 'variants'],
    additionalProperties: false,
  },
  output: z.object({ contentRevisionId: z.string(), state: z.literal('draft') }),
  action: 'content.edit',
  effect: 'draft',
});

export const reviewRequest = pending({
  name: 'review.request',
  description: 'Proposes a review request for a content revision; a person with review.decide decides.',
  input: z
    .object({
      contentRevisionId: z.string(),
      reviewerUserIds: z.array(z.string()).max(20).default([]),
      note: z.string().max(1000).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      contentRevisionId: { type: 'string' },
      reviewerUserIds: { type: 'array', items: { type: 'string' } },
      note: str(1000),
    },
    required: ['contentRevisionId'],
    additionalProperties: false,
  },
  output: z.object({ reviewRequestId: z.string(), state: z.literal('proposed') }),
  action: 'review.request',
  effect: 'propose',
});

export const experimentsProposeDesign = pending({
  name: 'experiments.proposeDesign',
  description: 'Proposes a pre-registration draft for an experiment; an analyst approves it.',
  input: z
    .object({
      recommendationId: z.string().optional(),
      hypothesis: z.string().max(2000),
      primaryMetricKey: z.string().max(80),
      variants: z
        .array(z.object({ key: z.string().max(40), description: z.string().max(1000) }))
        .min(2)
        .max(6),
    })
    .strict(),
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
  output: z.object({ experimentId: z.string(), state: z.literal('proposed') }),
  action: 'experiment.manage',
  effect: 'propose',
});

export const recommendationsCreate = pending({
  name: 'recommendations.create',
  description: 'Creates a recommendation with evidence for a person to accept or dismiss; proposes only.',
  input: z
    .object({
      title: z.string().min(1).max(200),
      rationale: z.string().max(4000),
      evidenceRefs: z.array(z.string().max(200)).max(50).default([]),
      suggestedAction: z.enum(['brief', 'variant', 'experiment', 'playbook_entry']),
    })
    .strict(),
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
  output: z.object({ recommendationId: z.string(), state: z.literal('proposed') }),
  action: 'insight.read',
  effect: 'propose',
});

/**
 * publications.proposeSchedule: propose, publication.schedule. Contract: creates a *pending proposal* (content
 * revision + channel connections + proposed slot) that a person with publication.schedule completes through
 * publications.schedule with a valid approval, or that the deterministic release policy completes under a managed
 * autopublish mandate (spec 13.4). The model never publishes and never schedules directly.
 */
export const publicationsProposeSchedule = pending({
  name: 'publications.proposeSchedule',
  description:
    'Proposes a publication slot for an approved content revision on given channel connections. Creates a pending proposal only; a person or the release policy completes it.',
  input: z
    .object({
      contentRevisionId: z.string(),
      channelConnectionIds: z.array(z.string()).min(1).max(20),
      proposedAt: z.string().datetime(),
      rationale: z.string().max(1000).optional(),
    })
    .strict(),
  inputSchema: {
    type: 'object',
    properties: {
      contentRevisionId: { type: 'string' },
      channelConnectionIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
      proposedAt: { type: 'string', format: 'date-time' },
      rationale: str(1000),
    },
    required: ['contentRevisionId', 'channelConnectionIds', 'proposedAt'],
    additionalProperties: false,
  },
  output: z.object({ proposalId: z.string(), state: z.literal('pending_proposal') }),
  action: 'publication.schedule',
  effect: 'propose',
});
