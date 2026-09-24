import { z } from 'zod';
import { PageRequest } from './pagination';

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
export type SkillScope = z.infer<typeof SkillScope>;

/**
 * Spec 12.4: the Release 1 tool registry. A manifest's allowedTools must be a subset of this list and never widens a
 * principal's grants; the ai package's dispatcher asserts against the same constant.
 */
export const TOOL_NAMES_RELEASE_1 = [
  'brand.getSnapshot',
  'assets.searchEligible',
  'facts.list',
  'metrics.query',
  'voice.clusters',
  'content.createBrief',
  'content.draftCopy',
  'creative.proposeOperations',
  'creative.requestRender',
  'images.generate',
  'review.runBrandReview',
  'review.request',
  'experiments.proposeDesign',
  'recommendations.create',
  'publications.proposeSchedule',
] as const;
export type ToolNameRelease1 = (typeof TOOL_NAMES_RELEASE_1)[number];

/** Spec 19.6: the deterministic properties an evaluation case can expect; a model-graded score never replaces them. */
export const EvaluationProperty = z.enum([
  'schema_valid',
  'only_eligible_assets',
  'claims_reference_facts',
  'no_prohibited_terms',
  'protected_elements_untouched',
  'budget_respected',
]);
export type EvaluationProperty = z.infer<typeof EvaluationProperty>;

export const EvaluationRubricDimension = z.object({
  dimension: z.string().min(1).max(80),
  description: z.string().max(1000),
  minScore: z.number().min(0).max(10),
});

/** One evaluation case: an input, the fixture brand it runs against and the properties the output must have. */
export const EvaluationCase = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  input: z.record(z.unknown()),
  brandFixtureRef: z.string().min(1).max(80),
  expected: z.object({
    properties: z.array(EvaluationProperty).min(1),
    rubric: z.array(EvaluationRubricDimension).max(20).optional(),
  }),
});
export type EvaluationCase = z.infer<typeof EvaluationCase>;

/** Spec 19.6: variance is reported over at least three runs. */
export const EVALUATION_RUNS_MIN = 3;

export const EvaluationDeterministicCheck = z.object({
  check: EvaluationProperty,
  passed: z.boolean(),
  detail: z.string().max(2000).optional(),
});
export const EvaluationRubricScore = z.object({
  dimension: z.string().min(1).max(80),
  mean: z.number(),
  variance: z.number().min(0),
  scores: z.array(z.number()),
});
export const EvaluationCaseReport = z.object({
  caseId: z.string(),
  deterministic: z.array(EvaluationDeterministicCheck),
  rubric: z.array(EvaluationRubricScore),
  passed: z.boolean(),
});
export const EvaluationReport = z.object({
  skillVersionId: z.string(),
  runs: z.number().int().min(1),
  cases: z.array(EvaluationCaseReport),
  passed: z.boolean(),
  gradedBy: z.object({ provider: z.string(), model: z.string() }).nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});
export type EvaluationReport = z.infer<typeof EvaluationReport>;

/** Spec 10.2: published (rollout %). */
export const SkillRolloutPercent = z.number().int().min(0).max(100);

/** A file of an Agent Skills package (SKILL.md, manifest.json, references/*, assets/*). Text only in Release 1. */
export const SkillFile = z.object({ path: z.string().min(1).max(200), content: z.string().max(500_000) });
export type SkillFile = z.infer<typeof SkillFile>;
export const SkillPackage = z.object({ files: z.array(SkillFile).min(1).max(100) });
export type SkillPackage = z.infer<typeof SkillPackage>;

/** Spec 12.3: what the context resolver receives per pinned skill version. */
export const ResolvedSkill = z.object({
  skillVersionId: z.string(),
  skillId: z.string(),
  key: z.string(),
  versionNumber: z.number().int(),
  manifest: SkillManifestV1,
  instructions: z.string(),
  references: z.array(SkillFile),
});
export type ResolvedSkill = z.infer<typeof ResolvedSkill>;

// ---- router DTOs ----
export const SkillList = z.object({
  scope: SkillScope.optional(),
  brandId: z.string().optional(),
  page: PageRequest,
});
export const SkillGet = z.object({ skillId: z.string() });
export const SkillVersionCreate = z.object({
  /** Append to an existing skill; otherwise the skill is found or created by manifest.key in `scope`. */
  skillId: z.string().optional(),
  /** Optional cross-check; must equal manifest.key when given. */
  skillKey: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  scope: SkillScope.default('tenant'),
  brandId: z.string().optional(),
  /** Parsed as SkillManifestV1 by the service after the declarative check (a `scripts` field is refused, not stripped). */
  manifest: z.record(z.unknown()),
  instructions: z.string().min(1).max(200_000),
  references: z.array(SkillFile).max(100).default([]),
  cases: z.array(EvaluationCase).max(100).optional(),
});
export const SkillVersionEvaluate = z.object({
  skillVersionId: z.string(),
  expectedVersion: z.number().int(),
  /** New cases replace the version's suite; otherwise the latest suite of the version is used. */
  cases: z.array(EvaluationCase).min(1).max(100).optional(),
  runs: z.number().int().min(EVALUATION_RUNS_MIN).max(20).default(EVALUATION_RUNS_MIN),
});
export const SkillVersionPublish = z.object({
  skillVersionId: z.string(),
  expectedVersion: z.number().int(),
  rolloutPercent: SkillRolloutPercent.default(100),
});
export const SkillBindingSet = z.object({
  scope: SkillScope,
  brandId: z.string().optional(),
  skillId: z.string(),
  /** null unbinds at that scope; an earlier published version is a rollback (future runs only). */
  skillVersionId: z.string().nullable(),
});
export const SkillImport = z.object({
  files: z.array(SkillFile).min(1).max(100),
  scope: SkillScope.default('tenant'),
  brandId: z.string().optional(),
  cases: z.array(EvaluationCase).max(100).optional(),
});
export const SkillExport = z.object({ skillVersionId: z.string() });
