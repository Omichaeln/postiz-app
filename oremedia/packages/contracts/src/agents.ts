import { z } from 'zod';
import { AutonomyMode } from './tenancy';

export const AgentRunState = z.enum([
  'planned',
  'running',
  'waiting_for_review',
  'completed',
  'failed',
  'cancelled',
  'budget_exhausted',
  'policy_denied',
  'waiting_expired',
]);
export type AgentRunState = z.infer<typeof AgentRunState>;

export const Budget = z.object({
  maxSteps: z.number().int().min(1).max(50),
  maxTokens: z.number().int().min(1),
  maxCostMicros: z.number().int().min(0),
  maxVariants: z.number().int().min(1).max(12),
  deadlineSeconds: z.number().int().min(1).max(1800),
});
export type Budget = z.infer<typeof Budget>;

export const AgentRunInput = z.object({
  runId: z.string(),
  tenantId: z.string(),
  brandId: z.string(),
  servicePrincipalId: z.string(),
  initiatorUserId: z.string().optional(),
  requestedAutonomy: AutonomyMode,
  taskKind: z.string(),
  brief: z.record(z.unknown()),
  correlationId: z.string(),
});
export type AgentRunInput = z.infer<typeof AgentRunInput>;

export const AgentRunResult = z.object({
  runId: z.string(),
  state: AgentRunState,
  costMicros: z.number().int(),
});
export type AgentRunResult = z.infer<typeof AgentRunResult>;

export const ProposalDecision = z.object({
  stepId: z.string(),
  decision: z.enum(['accept', 'reject', 'modify']),
  batch: z.unknown().optional(),
});
export type ProposalDecision = z.infer<typeof ProposalDecision>;

export const ModelToolCall = z.object({ id: z.string(), name: z.string(), arguments: z.unknown() });
export type ModelToolCall = z.infer<typeof ModelToolCall>;

export type ToolEffect = 'read' | 'draft' | 'propose' | 'external';

export type ToolResult =
  | { kind: 'ok'; output: unknown }
  | { kind: 'denied'; reason: string }
  | { kind: 'invalid'; issues: Array<{ path?: string; issue: string }> }
  | { kind: 'proposal_requires_user'; stepId: string; proposalRef: string };

export const AgentStepKind = z.enum(['plan', 'model_call', 'tool_call', 'validation']);

export const RunStart = z.object({
  brandId: z.string(),
  servicePrincipalId: z.string(),
  requestedAutonomy: AutonomyMode.default('create'),
  taskKind: z.string(),
  brief: z.record(z.unknown()),
});
