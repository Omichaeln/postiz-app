import { describe, expect, it } from 'vitest';
import { DEFAULT_WEIGHTS, engagementQuality, resolveWeights, type QualityComponentInput } from './quality';

const c = (value: number | null, evidence: string[] = []): QualityComponentInput => ({ value, evidence });
const all = {
  saves: c(10, ['ms_s']),
  shares: c(5, ['ms_sh']),
  substantive_comments: c(4, ['msg_1']),
  repeat_engagers: c(2, ['h1']),
  negative_feedback: c(1, ['ms_n']),
};

describe('engagement quality composite (spec 15.3)', () => {
  it('equal weights by default; negative feedback subtracts; every component is drillable', () => {
    const r = engagementQuality(all, null, null);
    expect(r.weightsSource).toBe('default');
    expect(r.score).toBe((10 + 5 + 4 + 2 - 1) / 5);
    expect(r.components.map((x) => x.component)).toEqual(Object.keys(DEFAULT_WEIGHTS));
    expect(r.components.find((x) => x.component === 'negative_feedback')?.contribution).toBe(-1);
    expect(r.components.find((x) => x.component === 'saves')?.evidence).toEqual(['ms_s']);
    expect(r.unavailable).toEqual([]);
  });
  it('brand weights change the composite and are reported as the source', () => {
    const r = engagementQuality(all, { saves: 3, shares: 0, bogus: 9, negative_feedback: -4 }, null);
    expect(r.weightsSource).toBe('brand_objective');
    // shares weight 0 drops out of the weighted mean; the negative weight is refused (default 1 kept).
    expect(r.score).toBe(Math.round(((3 * 10 + 4 + 2 - 1) / (3 + 1 + 1 + 1)) * 1000) / 1000);
    expect(resolveWeights({ bogus: 1 }).source).toBe('default');
  });
  it('an unavailable component is left out and named, never treated as zero', () => {
    const r = engagementQuality(
      { ...all, substantive_comments: c(null), repeat_engagers: c(null) },
      null,
      null,
    );
    expect(r.unavailable).toEqual(['substantive_comments', 'repeat_engagers']);
    expect(r.score).toBe(Math.round(((10 + 5 - 1) / 3) * 1000) / 1000);
    const none = engagementQuality(
      {
        saves: c(null),
        shares: c(null),
        substantive_comments: c(null),
        repeat_engagers: c(null),
        negative_feedback: c(null),
      },
      null,
      null,
    );
    expect(none.score).toBeNull();
  });
  it('normalises per 1,000 impressions when a base is known', () => {
    const r = engagementQuality(all, null, 2000);
    expect(r.impressionsBase).toBe(2000);
    expect(r.components.find((x) => x.component === 'saves')?.normalised).toBe(5);
    expect(r.score).toBe((5 + 2.5 + 2 + 1 - 0.5) / 5);
  });
});
