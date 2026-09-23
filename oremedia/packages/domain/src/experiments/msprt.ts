/**
 * Mixture sequential probability ratio test for a difference in two proportions (Johari, Pekelis, Walsh 2017),
 * an always-valid method for early monitoring chosen at pre-registration (spec 16.6). Never use repeated
 * fixed-horizon peeking.
 *
 * Λ_n = sqrt(2σ² / (2σ² + nτ²)) · exp( n² τ² (p̂_B − p̂_A)² / (4σ² (2σ² + nτ²)) ), reject H0 when Λ_n ≥ 1/α.
 * n is the per-arm sample size (balanced approximation: n = harmonic mean of the two arms).
 */
export function msprtTwoProportion(
  a: { x: number; n: number },
  b: { x: number; n: number },
  tau: number,
  alpha = 0.05,
): { lambda: number; reject: boolean; pAlwaysValid: number } {
  if (a.n === 0 || b.n === 0) return { lambda: 1, reject: false, pAlwaysValid: 1 };
  const n = (2 * a.n * b.n) / (a.n + b.n);
  const pA = a.x / a.n;
  const pB = b.x / b.n;
  const pooled = (a.x + b.x) / (a.n + b.n);
  const sigma2 = Math.max(pooled * (1 - pooled), 1e-12);
  const tau2 = tau * tau;
  const denom = 2 * sigma2 + n * tau2;
  const lambda =
    Math.sqrt((2 * sigma2) / denom) * Math.exp((n * n * tau2 * (pB - pA) ** 2) / (4 * sigma2 * denom));
  return { lambda, reject: lambda >= 1 / alpha, pAlwaysValid: Math.min(1, 1 / lambda) };
}
