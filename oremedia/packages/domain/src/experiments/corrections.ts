/** Holm–Bonferroni step-down correction across a pre-registered family (spec 16.6). */
export function holmBonferroni(
  pValues: readonly number[],
  alpha = 0.05,
): { adjusted: number[]; reject: boolean[] } {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m).fill(1);
  const reject = new Array<boolean>(m).fill(false);
  let running = 0;
  let stop = false;
  order.forEach(({ p, i }, k) => {
    const adj = Math.min(1, Math.max(running, (m - k) * p));
    running = adj;
    adjusted[i] = adj;
    if (!stop && p <= alpha / (m - k)) reject[i] = true;
    else stop = true;
  });
  return { adjusted, reject };
}

/** Winsorise a sample at a pre-registered upper percentile (and symmetric lower tail). */
export function winsorise(values: readonly number[], percentile: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const hiIdx = Math.min(sorted.length - 1, Math.floor(percentile * (sorted.length - 1)));
  const loIdx = Math.max(0, Math.floor((1 - percentile) * (sorted.length - 1)));
  const hi = sorted[hiIdx] as number;
  const lo = sorted[loIdx] as number;
  return values.map((v) => Math.min(hi, Math.max(lo, v)));
}
