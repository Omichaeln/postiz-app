/** Spec 19.6: scores are reported with variance over at least three runs. Population variance; NaN-free. */
export const mean = (values: readonly number[]): number =>
  values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;

export const variance = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const m = mean(values);
  return values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
};

export const MIN_EVALUATION_RUNS = 3;
