/**
 * Spec 15.3 engagement quality: a brand-configurable composite over saves, shares, substantive comments, repeat
 * engagers and negative feedback. Weights default to equal; a component the data cannot supply is reported as
 * unavailable and left out of the composite (never treated as zero), and every result carries its components.
 */
export const QUALITY_COMPONENTS = [
  'saves',
  'shares',
  'substantive_comments',
  'repeat_engagers',
  'negative_feedback',
] as const;
export type QualityComponent = (typeof QUALITY_COMPONENTS)[number];

/** Negative feedback lowers the score; everything else raises it. */
const SIGN: Record<QualityComponent, 1 | -1> = {
  saves: 1,
  shares: 1,
  substantive_comments: 1,
  repeat_engagers: 1,
  negative_feedback: -1,
};

export interface QualityComponentInput {
  value: number | null;
  /** The snapshot / message references the number was computed from (drill-down, spec 15.3). */
  evidence: string[];
}

export interface QualityComponentResult {
  component: QualityComponent;
  weight: number;
  value: number | null;
  /** value per 1,000 impressions when a base is given, else the raw count. */
  normalised: number | null;
  contribution: number | null;
  evidence: string[];
  available: boolean;
}

export interface QualityResult {
  score: number | null;
  components: QualityComponentResult[];
  weightsSource: 'default' | 'brand_objective';
  /** Components without data: the composite is computed over the rest and says so. */
  unavailable: QualityComponent[];
  impressionsBase: number | null;
}

export const DEFAULT_WEIGHTS: Readonly<Record<QualityComponent, number>> = {
  saves: 1,
  shares: 1,
  substantive_comments: 1,
  repeat_engagers: 1,
  negative_feedback: 1,
};

/** Brand weights are validated on read: unknown keys are ignored, missing ones default, negatives are refused. */
export function resolveWeights(configured: Record<string, number> | null | undefined): {
  weights: Record<QualityComponent, number>;
  source: QualityResult['weightsSource'];
} {
  if (!configured) return { weights: { ...DEFAULT_WEIGHTS }, source: 'default' };
  const weights = { ...DEFAULT_WEIGHTS };
  let any = false;
  for (const c of QUALITY_COMPONENTS) {
    const w = configured[c];
    if (typeof w === 'number' && Number.isFinite(w) && w >= 0) {
      weights[c] = w;
      any = true;
    }
  }
  return { weights, source: any ? 'brand_objective' : 'default' };
}

export function engagementQuality(
  inputs: Record<QualityComponent, QualityComponentInput>,
  configuredWeights: Record<string, number> | null | undefined,
  impressionsBase: number | null,
): QualityResult {
  const { weights, source } = resolveWeights(configuredWeights);
  const base = impressionsBase !== null && impressionsBase > 0 ? impressionsBase : null;
  const components: QualityComponentResult[] = QUALITY_COMPONENTS.map((component) => {
    const input = inputs[component];
    const available = input.value !== null;
    const normalised = !available ? null : base ? ((input.value as number) / base) * 1000 : input.value;
    return {
      component,
      weight: weights[component],
      value: input.value,
      normalised,
      contribution: normalised === null ? null : SIGN[component] * weights[component] * normalised,
      evidence: input.evidence,
      available,
    };
  });
  const usable = components.filter((c) => c.available && c.weight > 0);
  const weightSum = usable.reduce((s, c) => s + c.weight, 0);
  const score =
    usable.length === 0 || weightSum === 0
      ? null
      : Math.round((usable.reduce((s, c) => s + (c.contribution as number), 0) / weightSum) * 1000) / 1000;
  return {
    score,
    components,
    weightsSource: source,
    unavailable: components.filter((c) => !c.available).map((c) => c.component),
    impressionsBase: base,
  };
}
