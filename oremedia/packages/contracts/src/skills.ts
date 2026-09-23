import { z } from 'zod';

export const TaskKind = z.enum([
  'brand_onboarding',
  'campaign_planning',
  'copywriting',
  'layout',
  'channel_adaptation',
  'brand_review',
  'performance_review',
  'community_response',
  'experiment_design',
]);
export type TaskKind = z.infer<typeof TaskKind>;

export const RequiredContext = z.enum([
  'brand_snapshot',
  'eligible_assets',
  'approved_facts',
  'metrics',
  'customer_voice',
  'playbook',
]);

/** Spec 10.1: declarative-only skill manifest (no executable scripts in Release 1). */
export const SkillManifestV1 = z.object({
  schemaVersion: z.literal(1),
  key: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  description: z.string().max(1000),
  taskKinds: z.array(TaskKind),
  inputSchema: z.record(z.unknown()), // JSON Schema
  outputSchema: z.record(z.unknown()), // JSON Schema; outputs are validated
  requiredContext: z.array(RequiredContext),
  allowedTools: z.array(z.string()), // subset of the tool registry; never widens a principal's grants
  budgets: z.object({
    maxSteps: z.number().int().max(50),
    maxTokens: z.number().int(),
    maxCostMicros: z.number().int(),
    maxVariants: z.number().int().max(12),
    deadlineSeconds: z.number().int().max(1800),
  }),
  modelCompatibility: z.array(z.string()),
  instructionsPath: z.literal('SKILL.md'),
});
export type SkillManifestV1 = z.infer<typeof SkillManifestV1>;

export const SkillVersionState = z.enum(['draft', 'sandbox_evaluation', 'in_review', 'published', 'retired']);
export type SkillVersionState = z.infer<typeof SkillVersionState>;

export const SkillScope = z.enum(['platform', 'tenant', 'brand']);
