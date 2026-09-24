import { describe, expect, it } from 'vitest';
import type { PreRegistrationV1 } from '@oremedia/contracts/experiments';
import { analyseExperiment } from './analysis';

const design = (over: Partial<PreRegistrationV1> = {}): PreRegistrationV1 => ({
  v: 1,
  hypothesis: 'h',
  mode: 'randomised',
  variants: [
    { label: 'c', contentRevisionId: 'crev_c', allocationWeight: 1 },
    { label: 't', contentRevisionId: 'crev_t', allocationWeight: 1 },
  ],
  primaryMetricKey: 'rate',
  guardrailMetricKeys: ['enquiries'],
  guardrailThresholds: {},
  allocationMethod: 'hashed_visitor',
  unitType: 'visitor',
  minSamplePerArm: 100,
  observationWindowHours: 24,
  stoppingRule: { kind: 'fixed_horizon', alpha: 0.05 },
  ...over,
});
const arms = ['xv_c', 'xv_t', 'xv_u'];

describe('experiment decision rule (spec 16.6)', () => {
  it('a significant primary win with an intact guardrail is supported', () => {
    const r = analyseExperiment(design(), arms.slice(0, 2), [
      { variantId: 'xv_c', n: 1000, x: 50, guardrails: { enquiries: 30 } },
      { variantId: 'xv_t', n: 1000, x: 90, guardrails: { enquiries: 31 } },
    ]);
    expect(r.verdict).toBe('supported');
    expect(r.methodVersion).toBe('two_proportion_holm_v1');
    expect(r.estimate).toBeCloseTo(0.04, 9);
  });

  it('engagement up but qualified enquiries down beyond the threshold is not_supported for the objective', () => {
    const r = analyseExperiment(design({ guardrailThresholds: { enquiries: 0.01 } }), arms.slice(0, 2), [
      { variantId: 'xv_c', n: 1000, x: 50, guardrails: { enquiries: 40 } },
      { variantId: 'xv_t', n: 1000, x: 90, guardrails: { enquiries: 25 } },
    ]);
    expect(r.verdict).toBe('not_supported');
    expect(r.guardrailBreached).toEqual(['enquiries:xv_t']);
  });

  it('applies Holm–Bonferroni across several treatments and reports the best arm', () => {
    const r = analyseExperiment(
      design({
        variants: [...design().variants, { label: 'u', contentRevisionId: 'crev_u', allocationWeight: 1 }],
      }),
      arms,
      [
        { variantId: 'xv_c', n: 1000, x: 50, guardrails: {} },
        { variantId: 'xv_t', n: 1000, x: 62, guardrails: {} },
        { variantId: 'xv_u', n: 1000, x: 95, guardrails: {} },
      ],
    );
    expect(r.verdict).toBe('supported');
    expect(r.estimate).toBeCloseTo(0.045, 9);
    expect(r.pValue).toBeGreaterThan(0);
  });

  it('is inconclusive without data or without significance, and directional for a structured comparison', () => {
    expect(analyseExperiment(design(), arms.slice(0, 2), []).verdict).toBe('inconclusive');
    const flat = analyseExperiment(
      design({
        mode: 'structured_comparison',
        allocationMethod: 'matched_slots',
        unitType: 'publication_slot',
      }),
      arms.slice(0, 2),
      [
        { variantId: 'xv_c', n: 300, x: 30, guardrails: {} },
        { variantId: 'xv_t', n: 300, x: 33, guardrails: {} },
      ],
    );
    expect(flat.verdict).toBe('inconclusive');
    expect(flat.verdictReason).toBe('directional; not causal: not_significant');
    expect(flat.methodVersion).toBe('structured_comparison:two_proportion_holm_v1');
  });

  it('uses Welch on per-unit values, winsorised at the pre-registered percentile', () => {
    const heavy = [...Array.from({ length: 60 }, (_, i) => 10 + (i % 5)), 5000];
    const better = Array.from({ length: 60 }, (_, i) => 14 + (i % 5));
    const r = analyseExperiment(design({ winsorisePercentile: 0.95 }), arms.slice(0, 2), [
      { variantId: 'xv_c', n: 61, x: 0, values: heavy, guardrails: {} },
      { variantId: 'xv_t', n: 60, x: 0, values: better, guardrails: {} },
    ]);
    expect(r.methodVersion).toBe('welch_v1');
    expect(r.verdict).toBe('supported');
  });

  it('uses the always-valid mSPRT when pre-registered', () => {
    const r = analyseExperiment(
      design({ stoppingRule: { kind: 'sequential_msprt', alpha: 0.05, tau: 1 } }),
      arms.slice(0, 2),
      [
        { variantId: 'xv_c', n: 3000, x: 150, guardrails: {} },
        { variantId: 'xv_t', n: 3000, x: 330, guardrails: {} },
      ],
    );
    expect(r.methodVersion).toBe('msprt_v1');
    expect(r.verdict).toBe('supported');
  });
});
