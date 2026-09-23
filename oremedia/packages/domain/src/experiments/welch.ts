/** Welch's t-test on per-unit values (continuous metrics, spec 16.6). p-value via regularised incomplete beta. */
function lnGamma(x: number): number {
  const g = [
    76.1800917294715, -86.50532032941677, 24.01409824083091, -1.231739572450155, 1.208650973866179e-3,
    -5.395239384953e-6,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.506628274631 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). */
export function regularisedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Two-sided p-value for Student's t with df degrees of freedom. */
export function tTwoSidedP(t: number, df: number): number {
  const x = df / (df + t * t);
  return regularisedBeta(x, df / 2, 0.5);
}

function meanVar(v: readonly number[]): { mean: number; variance: number } {
  const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const variance = n > 1 ? v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, variance };
}

export type WelchResult =
  | { verdict: 'inconclusive'; reason: 'insufficient_data' }
  | { diff: number; t: number; df: number; p: number; ci: readonly [number, number] };

export function welchT(a: readonly number[], b: readonly number[], alpha = 0.05): WelchResult {
  if (a.length < 2 || b.length < 2) return { verdict: 'inconclusive', reason: 'insufficient_data' };
  const A = meanVar(a);
  const B = meanVar(b);
  const seA = A.variance / a.length;
  const seB = B.variance / b.length;
  const se = Math.sqrt(seA + seB);
  const diff = B.mean - A.mean;
  if (se === 0)
    return { diff, t: 0, df: a.length + b.length - 2, p: diff === 0 ? 1 : 0, ci: [diff, diff] as const };
  const t = diff / se;
  const df = (seA + seB) ** 2 / (seA ** 2 / (a.length - 1) + seB ** 2 / (b.length - 1));
  const p = tTwoSidedP(t, df);
  // CI half-width from the t quantile; approximate via bisection on the two-sided p.
  let lo = 0;
  let hi = 50;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (tTwoSidedP(mid, df) > alpha) lo = mid;
    else hi = mid;
  }
  const tc = (lo + hi) / 2;
  return { diff, t, df, p, ci: [diff - tc * se, diff + tc * se] as const };
}
