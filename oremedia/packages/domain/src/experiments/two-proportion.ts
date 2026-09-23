import { normalCdf, normalQuantile } from './normal';

export type TwoProportionResult =
  | { verdict: 'inconclusive'; reason: 'no_data' }
  | { diff: number; ci: readonly [number, number]; p: number; z: number };

/**
 * Spec 16.6: fixed-horizon two-sided test on conversion-type metrics (e.g. qualified enquiry rate per click).
 * Returns the estimate only; the verdict is assigned by the pre-registered decision rule.
 */
export function twoProportion(
  a: { x: number; n: number },
  b: { x: number; n: number },
  alpha = 0.05,
): TwoProportionResult {
  if (a.n === 0 || b.n === 0) return { verdict: 'inconclusive', reason: 'no_data' };
  const pA = a.x / a.n;
  const pB = b.x / b.n;
  const pooled = (a.x + b.x) / (a.n + b.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n));
  const z = se === 0 ? 0 : (pB - pA) / se;
  const p = 2 * (1 - normalCdf(Math.abs(z)));
  const seDiff = Math.sqrt((pA * (1 - pA)) / a.n + (pB * (1 - pB)) / b.n);
  const zc = normalQuantile(1 - alpha / 2);
  return { diff: pB - pA, ci: [pB - pA - zc * seDiff, pB - pA + zc * seDiff] as const, p, z };
}

export function requiredSamplePerArm(
  baseline: number,
  minDetectableLift: number,
  alpha = 0.05,
  power = 0.8,
): number {
  const p1 = baseline;
  const p2 = baseline * (1 + minDetectableLift);
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const pBar = (p1 + p2) / 2;
  return Math.ceil(
    (za * Math.sqrt(2 * pBar * (1 - pBar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 /
      (p2 - p1) ** 2,
  );
}
