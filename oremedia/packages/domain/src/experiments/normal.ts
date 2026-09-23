/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation (|err| < 1.5e-7). */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export const normalCdf = (z: number): number => 0.5 * (1 + erf(z / Math.SQRT2));

// Acklam's rational approximation coefficients.
const A0 = -3.969683028665376e1;
const A1 = 2.209460984245205e2;
const A2 = -2.759285104469687e2;
const A3 = 1.38357751867269e2;
const A4 = -3.066479806614716e1;
const A5 = 2.506628277459239;
const B0 = -5.447609879822406e1;
const B1 = 1.615858368580409e2;
const B2 = -1.556989798598866e2;
const B3 = 6.680131188771972e1;
const B4 = -1.328068155288572e1;
const C0 = -7.784894002430293e-3;
const C1 = -3.223964580411365e-1;
const C2 = -2.400758277161838;
const C3 = -2.549732539343734;
const C4 = 4.374664141464968;
const C5 = 2.938163982698783;
const D0 = 7.784695709041462e-3;
const D1 = 3.224671290700398e-1;
const D2 = 2.445134137142996;
const D3 = 3.754408661907416;
const P_LOW = 0.02425;
const P_HIGH = 1 - P_LOW;

/** Inverse normal CDF: Acklam's algorithm (rel. error 1.15e-9) with one Newton refinement. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('normalQuantile: p must be in (0,1)');
  let x: number;
  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((C0 * q + C1) * q + C2) * q + C3) * q + C4) * q + C5) /
      ((((D0 * q + D1) * q + D2) * q + D3) * q + 1);
  } else if (p <= P_HIGH) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((A0 * r + A1) * r + A2) * r + A3) * r + A4) * r + A5) * q) /
      (((((B0 * r + B1) * r + B2) * r + B3) * r + B4) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((C0 * q + C1) * q + C2) * q + C3) * q + C4) * q + C5) /
      ((((D0 * q + D1) * q + D2) * q + D3) * q + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}
