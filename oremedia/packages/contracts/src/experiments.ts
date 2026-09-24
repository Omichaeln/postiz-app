import { z } from 'zod';

export const ExperimentMode = z.enum(['randomised', 'structured_comparison']);
export type ExperimentMode = z.infer<typeof ExperimentMode>;
export const ExperimentState = z.enum(['designed', 'pre_registered', 'running', 'stopped', 'analysed']);
export const ExperimentVerdict = z.enum(['supported', 'not_supported', 'inconclusive']);
export type ExperimentVerdict = z.infer<typeof ExperimentVerdict>;
export const UnitType = z.enum(['visitor', 'publication_slot']);

/** Spec 16.6: pre-registration is frozen with a hash; results against a changed design are rejected. */
export const PreRegistrationV1 = z.object({
  v: z.literal(1),
  hypothesis: z.string().min(1).max(2000),
  mode: ExperimentMode,
  variants: z
    .array(
      z.object({
        label: z.string().max(80),
        contentRevisionId: z.string(),
        allocationWeight: z.number().positive(),
      }),
    )
    .min(2)
    .max(6),
  primaryMetricKey: z.string().max(80),
  guardrailMetricKeys: z.array(z.string().max(80)).max(10),
  guardrailThresholds: z.record(z.number()).default({}),
  /** The direction that counts as a breach per guardrail (default `down`: a drop is adverse; `up` for complaints). */
  guardrailDirections: z.record(z.enum(['up', 'down'])).optional(),
  allocationMethod: z.enum(['hashed_visitor', 'matched_slots', 'random']),
  unitType: UnitType,
  minSamplePerArm: z.number().int().positive(),
  observationWindowHours: z.number().int().positive(),
  stoppingRule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fixed_horizon'), alpha: z.number().gt(0).lt(1).default(0.05) }),
    z.object({
      kind: z.literal('sequential_msprt'),
      alpha: z.number().gt(0).lt(1).default(0.05),
      tau: z.number().positive().default(1),
    }),
  ]),
  winsorisePercentile: z.number().min(0.5).max(1).optional(),
});
export type PreRegistrationV1 = z.infer<typeof PreRegistrationV1>;

export const ExperimentDesign = z.object({
  brandId: z.string(),
  recommendationId: z.string().optional(),
  design: PreRegistrationV1,
});

// ---------------------------------------------------------------------------------------------------------------
// Phase 6 experiments module (spec 16.6). Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PageRequest } from './pagination';

/** Spec 16.6 conclusion strength shown next to every result. */
export const ExperimentConclusionLabel = z.enum(['causal_when_sound', 'directional; not causal']);
export type ExperimentConclusionLabel = z.infer<typeof ExperimentConclusionLabel>;
export const conclusionLabelFor = (mode: ExperimentMode): ExperimentConclusionLabel =>
  mode === 'randomised' ? 'causal_when_sound' : 'directional; not causal';

export const ExperimentCreate = ExperimentDesign;
export const ExperimentPreRegister = z.object({
  experimentId: z.string(),
  expectedVersion: z.number().int(),
});
export const ExperimentStart = z.object({ experimentId: z.string(), expectedVersion: z.number().int() });
export const ExperimentStop = z.object({
  experimentId: z.string(),
  expectedVersion: z.number().int(),
  reason: z.string().max(500).optional(),
});
export const ExperimentGet = z.object({ experimentId: z.string() });
export const ExperimentList = z.object({
  brandId: z.string(),
  state: ExperimentState.optional(),
  page: PageRequest,
});

/** Delivered observations per variant as the measurement side reports them (spec 16.6: exposure per variant). */
export const VariantObservation = z.object({
  variantId: z.string(),
  /** Units observed (clicks, visitors, slots). */
  n: z.number().int().nonnegative(),
  /** Primary-metric successes among n (conversion-type metrics). */
  x: z.number().int().nonnegative(),
  /** Delivered exposure (impressions / spend units) recorded separately from n; never assumed equal across arms. */
  exposure: z.number().nonnegative().optional(),
  /** Per-unit values for a continuous primary metric (Welch), winsorised at the pre-registered percentile. */
  values: z.array(z.number()).max(20000).optional(),
  /** Guardrail successes among n per guardrail metric key. */
  guardrails: z.record(z.number().int().nonnegative()).default({}),
});
export type VariantObservation = z.infer<typeof VariantObservation>;

/**
 * Results are computed against the frozen design: the caller states the hash it analysed under, and a mismatch
 * (the design changed after pre-registration) is rejected (spec 16.6).
 */
export const ExperimentResults = z.object({
  experimentId: z.string(),
  preRegistrationHash: z.string().length(64),
  observations: z.array(VariantObservation).min(2).max(6),
  /** Analysis time; defaults to now. Results are never declared before the window has elapsed. */
  at: z.string().datetime().optional(),
});
export type ExperimentResults = z.infer<typeof ExperimentResults>;

export const ExperimentResultsGet = z.object({ experimentId: z.string() });

/** Spec 16.6 unit of randomisation for tracked-link experiments. */
export const ExperimentAssign = z.object({
  experimentId: z.string(),
  unitType: UnitType,
  /** Already hashed (salted per tenant) by the caller; never a raw visitor identity. */
  unitIdHash: z.string().min(16).max(64),
});
