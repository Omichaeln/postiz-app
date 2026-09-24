import { describe, expect, it } from 'vitest';
import {
  conclusionText,
  EMPTY_DESIGN,
  estimateText,
  experimentStateChip,
  formatRate,
  isDesignChanged,
  parseDesign,
  resultsRefusalText,
  shortHash,
  windowEnd,
} from './experiment-helpers';

describe('experimentStateChip', () => {
  it('labels every contract state and names an unknown one', () => {
    expect(experimentStateChip('pre_registered').label).toBe('Pre-registered');
    expect(experimentStateChip('odd').label).toBe('Unknown state (odd)');
  });
});

describe('resultsRefusalText', () => {
  it('explains the sample-and-window refusal (spec 16.6)', () => {
    const lines = resultsRefusalText([
      { path: 'at', issue: 'window_not_reached_until_2026-10-01T00:00:00.000Z' },
      { path: 'observations', issue: 'sample_below_30_per_arm' },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('has not ended');
    expect(lines[1]).toContain('minimum of 30 per arm');
  });
  it('drops the "reached" markers and keeps unknown issues verbatim', () => {
    expect(resultsRefusalText([{ path: 'at', issue: 'window_reached' }, { issue: 'other_issue' }])).toEqual([
      'other_issue',
    ]);
  });
  it('names a changed design', () => {
    const details = [{ path: 'preRegistrationHash', issue: 'design_changed' }];
    expect(isDesignChanged(details)).toBe(true);
    expect(resultsRefusalText(details)[0]).toContain('changed after pre-registration');
  });
});

describe('formatting', () => {
  it('formats rates, estimates, hashes, labels and window ends', () => {
    expect(formatRate(null)).toBe('unavailable');
    expect(formatRate(0.1234)).toBe('12.3%');
    expect(estimateText(null, null)).toContain('No estimate');
    expect(estimateText(0.02, [-0.01, 0.05])).toBe('Difference +2.0 pp (95% interval -1.0 pp to +5.0 pp).');
    expect(shortHash(null)).toBe('—');
    expect(shortHash('a'.repeat(64))).toBe(`${'a'.repeat(12)}…`);
    expect(conclusionText('directional; not causal')).toBe('directional; not causal');
    expect(windowEnd('2026-01-01T00:00:00.000Z', 24).toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('parseDesign', () => {
  it('rejects an empty form with paths', () => {
    const r = parseDesign(EMPTY_DESIGN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain('hypothesis');
  });
  it('builds a pre-registration document from a complete form', () => {
    const r = parseDesign({
      ...EMPTY_DESIGN,
      hypothesis: 'Shorter hooks lift saves',
      variants: [
        { label: 'A', contentRevisionId: 'cr_a', allocationWeight: '1' },
        { label: 'B', contentRevisionId: 'cr_b', allocationWeight: '1' },
      ],
      primaryMetricKey: 'saves',
      guardrailMetricKeys: 'complaints, unfollows',
      stoppingRule: 'sequential_msprt',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.design.guardrailMetricKeys).toEqual(['complaints', 'unfollows']);
      expect(r.design.stoppingRule.kind).toBe('sequential_msprt');
      expect(r.design.minSamplePerArm).toBe(30);
    }
  });
});
