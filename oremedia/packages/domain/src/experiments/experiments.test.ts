import { describe, expect, it } from 'vitest';
import { normalCdf, normalQuantile } from './normal';
import { requiredSamplePerArm, twoProportion } from './two-proportion';
import { holmBonferroni, winsorise } from './corrections';
import { tTwoSidedP, welchT } from './welch';
import { msprtTwoProportion } from './msprt';

describe('normal distribution', () => {
  it('cdf reference values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1)).toBeCloseTo(0.1586553, 5);
  });
  it('quantile reference values', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212, 5);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 7);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 4);
  });
});

describe('twoProportion', () => {
  it('no data → inconclusive', () => {
    expect(twoProportion({ x: 0, n: 0 }, { x: 1, n: 10 })).toEqual({
      verdict: 'inconclusive',
      reason: 'no_data',
    });
  });
  it('reference: 50/1000 vs 70/1000', () => {
    const r = twoProportion({ x: 50, n: 1000 }, { x: 70, n: 1000 });
    if ('verdict' in r) throw new Error('unexpected');
    expect(r.diff).toBeCloseTo(0.02, 10);
    expect(r.z).toBeCloseTo(1.8831, 3); // pooled z, computed independently: 0.02 / sqrt(0.06*0.94*2/1000)
    expect(r.p).toBeCloseTo(0.0597, 3);
    expect(r.ci[0]).toBeCloseTo(-0.0008, 3);
    expect(r.ci[1]).toBeCloseTo(0.0408, 3);
  });
  it('requiredSamplePerArm reference: baseline 5%, +20% lift, α .05, power .8', () => {
    expect(requiredSamplePerArm(0.05, 0.2)).toBe(8158); // ceil(8157.72)
  });
});

describe('Holm–Bonferroni', () => {
  it('reference example', () => {
    const { reject, adjusted } = holmBonferroni([0.01, 0.04, 0.03, 0.005], 0.05);
    expect(reject).toEqual([true, false, false, true]);
    expect(adjusted[3]).toBeCloseTo(0.02, 10);
    expect(adjusted[0]).toBeCloseTo(0.03, 10);
  });
  it('winsorise clamps tails', () => {
    expect(winsorise([1, 2, 3, 4, 100], 0.8)).toEqual([1, 2, 3, 4, 4]);
  });
});

describe('Welch t-test', () => {
  it('t distribution two-sided p reference', () => {
    expect(tTwoSidedP(2.0, 10)).toBeCloseTo(0.0734, 3);
    expect(tTwoSidedP(0, 5)).toBeCloseTo(1, 10);
  });
  it('reference example (unequal variances)', () => {
    const a = [27.5, 21.0, 19.0, 23.6, 17.0, 17.9, 16.9, 20.1, 21.9, 22.6, 23.1, 19.6, 19.0, 21.7, 21.4];
    const b = [27.1, 22.0, 20.8, 23.4, 23.4, 23.5, 25.8, 22.0, 24.8, 20.2, 21.9, 22.1, 22.9, 20.5, 24.4];
    const r = welchT(a, b);
    if ('verdict' in r) throw new Error('unexpected');
    expect(r.t).toBeCloseTo(2.4554, 3); // Wikipedia Welch example reports |t| = 2.46, df = 24.99, p = 0.021
    expect(r.df).toBeCloseTo(24.99, 1);
    expect(r.p).toBeCloseTo(0.021, 2);
  });
});

describe('mSPRT', () => {
  it('identical arms do not reject at small n', () => {
    expect(msprtTwoProportion({ x: 5, n: 100 }, { x: 5, n: 100 }, 0.1).reject).toBe(false);
  });
  it('a large, well-sampled difference rejects', () => {
    expect(msprtTwoProportion({ x: 500, n: 10000 }, { x: 800, n: 10000 }, 0.1).reject).toBe(true);
  });
  it('lambda is monotone in the observed difference', () => {
    const l1 = msprtTwoProportion({ x: 50, n: 1000 }, { x: 55, n: 1000 }, 0.1).lambda;
    const l2 = msprtTwoProportion({ x: 50, n: 1000 }, { x: 70, n: 1000 }, 0.1).lambda;
    expect(l2).toBeGreaterThan(l1);
  });
});
