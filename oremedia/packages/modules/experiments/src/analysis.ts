import type {
  PreRegistrationV1,
  VariantObservation,
  ExperimentVerdict,
} from '@oremedia/contracts/experiments';
import {
  holmBonferroni,
  msprtTwoProportion,
  twoProportion,
  welchT,
  winsorise,
} from '@oremedia/domain/experiments/index';

export interface AnalysisOutcome {
  perVariant: Record<string, { n: number; x: number; rate: number | null; exposure?: number }>;
  estimate: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  pValue: number | null;
  guardrailBreached: string[];
  verdict: ExperimentVerdict;
  verdictReason: string;
  methodVersion: string;
}

/** Spec 16.6 conclusion strength: a structured comparison is directional only, and says so in every result. */
export const DIRECTIONAL_LABEL = 'directional; not causal';

const rateOf = (o: { n: number; x: number }): number | null => (o.n === 0 ? null : o.x / o.n);

interface ArmTest {
  variantId: string;
  diff: number | null;
  ci: readonly [number, number] | null;
  p: number | null;
}

/**
 * The pre-registered decision rule, computed with the domain statistics (never reimplemented here): fixed-horizon
 * two-proportion (or Welch on per-unit values, winsorised at the pre-registered percentile) with Holm–Bonferroni
 * across the treatment family, or the always-valid mSPRT when that stopping rule was pre-registered. Guardrails
 * are checked per treatment against the control: a significant drop, or a drop beyond the pre-registered
 * threshold, is a breach and makes a primary win `not_supported` for the campaign objective.
 */
export function analyseExperiment(
  design: PreRegistrationV1,
  variantIds: readonly string[],
  observations: readonly VariantObservation[],
): AnalysisOutcome {
  const byVariant = new Map(observations.map((o) => [o.variantId, o]));
  const control = byVariant.get(variantIds[0] as string);
  const alpha = design.stoppingRule.alpha;
  const perVariant: AnalysisOutcome['perVariant'] = {};
  for (const id of variantIds) {
    const o = byVariant.get(id);
    perVariant[id] = o
      ? { n: o.n, x: o.x, rate: rateOf(o), ...(o.exposure !== undefined ? { exposure: o.exposure } : {}) }
      : { n: 0, x: 0, rate: null };
  }
  const label = (method: string, reason: string) =>
    design.mode === 'structured_comparison'
      ? { methodVersion: `structured_comparison:${method}`, verdictReason: `${DIRECTIONAL_LABEL}: ${reason}` }
      : { methodVersion: method, verdictReason: reason };
  const inconclusive = (method: string, reason: string): AnalysisOutcome => ({
    perVariant,
    estimate: null,
    intervalLow: null,
    intervalHigh: null,
    pValue: null,
    guardrailBreached: [],
    verdict: 'inconclusive',
    ...label(method, reason),
  });
  if (!control || control.n === 0) return inconclusive('two_proportion_v1', 'no_data');

  const treatments = variantIds
    .slice(1)
    .map((id) => byVariant.get(id))
    .filter((o): o is VariantObservation => !!o);
  if (treatments.length === 0) return inconclusive('two_proportion_v1', 'no_data');

  const continuous = control.values !== undefined && treatments.every((t) => t.values !== undefined);
  const sequential = design.stoppingRule.kind === 'sequential_msprt';
  const prep = (values: readonly number[]) =>
    design.winsorisePercentile ? winsorise(values, design.winsorisePercentile) : [...values];
  let method: string;
  const tests: ArmTest[] = [];
  if (sequential) {
    method = 'msprt_v1';
    const tau = design.stoppingRule.kind === 'sequential_msprt' ? design.stoppingRule.tau : 1;
    for (const t of treatments) {
      const r = msprtTwoProportion(control, t, tau, alpha);
      const fixed = twoProportion(control, t, alpha);
      tests.push({
        variantId: t.variantId,
        diff: 'diff' in fixed ? fixed.diff : null,
        ci: 'ci' in fixed ? fixed.ci : null,
        p: r.pAlwaysValid,
      });
    }
  } else if (continuous) {
    method = 'welch_v1';
    const a = prep(control.values as number[]);
    for (const t of treatments) {
      const r = welchT(a, prep(t.values as number[]), alpha);
      tests.push({
        variantId: t.variantId,
        diff: 'diff' in r ? r.diff : null,
        ci: 'ci' in r ? r.ci : null,
        p: 'p' in r ? r.p : null,
      });
    }
  } else {
    method = 'two_proportion_holm_v1';
    for (const t of treatments) {
      const r = twoProportion(control, t, alpha);
      tests.push({
        variantId: t.variantId,
        diff: 'diff' in r ? r.diff : null,
        ci: 'ci' in r ? r.ci : null,
        p: 'p' in r ? r.p : null,
      });
    }
  }
  const tested = tests.filter(
    (t): t is ArmTest & { p: number; diff: number } => t.p !== null && t.diff !== null,
  );
  if (tested.length === 0) return inconclusive(method, 'no_data');
  // Holm–Bonferroni across the pre-registered family of treatments (a no-op for one treatment).
  const { adjusted, reject } = holmBonferroni(
    tested.map((t) => t.p),
    alpha,
  );
  const ranked = tested
    .map((t, i) => ({ ...t, adjustedP: adjusted[i] as number, reject: reject[i] as boolean }))
    .sort((x, y) => y.diff - x.diff);
  const best = ranked[0] as (typeof ranked)[number];

  // Guardrails: every treatment against the control, per pre-registered guardrail metric.
  const guardrailBreached: string[] = [];
  for (const key of design.guardrailMetricKeys) {
    const cx = control.guardrails[key];
    if (cx === undefined) continue;
    const threshold = design.guardrailThresholds[key];
    for (const t of treatments) {
      const tx = t.guardrails[key];
      if (tx === undefined) continue;
      const r = twoProportion({ x: cx, n: control.n }, { x: tx, n: t.n }, alpha);
      if (!('diff' in r)) continue;
      // Adverse = the pre-registered breach direction (a drop unless the guardrail is a harm such as complaints).
      const adverse = design.guardrailDirections?.[key] === 'up' ? r.diff : -r.diff;
      if (adverse <= 0) continue;
      const beyondThreshold = threshold !== undefined && adverse > threshold;
      if (beyondThreshold || r.p < alpha) guardrailBreached.push(`${key}:${t.variantId}`);
    }
  }

  const base = {
    perVariant,
    estimate: best.diff,
    intervalLow: best.ci ? best.ci[0] : null,
    intervalHigh: best.ci ? best.ci[1] : null,
    pValue: best.adjustedP,
    guardrailBreached,
  };
  if (guardrailBreached.length)
    return {
      ...base,
      verdict: 'not_supported',
      ...label(method, `guardrail_breach:${guardrailBreached.join(',')}`),
    };
  const anyReject = ranked.some((t) => t.reject);
  if (!anyReject) return { ...base, verdict: 'inconclusive', ...label(method, 'not_significant') };
  if (best.reject && best.diff > 0)
    return { ...base, verdict: 'supported', ...label(method, 'primary_metric_improved') };
  return { ...base, verdict: 'not_supported', ...label(method, 'primary_metric_worse') };
}
