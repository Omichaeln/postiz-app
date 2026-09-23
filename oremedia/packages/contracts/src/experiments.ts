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
