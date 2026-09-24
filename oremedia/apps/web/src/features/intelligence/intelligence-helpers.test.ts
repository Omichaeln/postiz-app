import { describe, expect, it } from 'vitest';
import {
  ageText,
  canApprovePlaybook,
  coverageText,
  defaultReviewAfter,
  freshnessText,
  hasCoverageGaps,
  insightLabel,
  levelChip,
} from './intelligence-helpers';

describe('freshnessText', () => {
  it('says "No data yet" when nothing was fetched', () => {
    expect(freshnessText({ asOf: null, ageHours: null, stale: true })).toBe('No data yet');
  });
  it('shows the fetched time and the age', () => {
    const asOf = new Date(Date.now() - 2 * 3600_000).toISOString();
    const text = freshnessText({ asOf, ageHours: 2, stale: false });
    expect(text).toContain('Fetched');
    expect(text).toContain('2 h ago');
  });
  it('formats ages in minutes, hours and days', () => {
    expect(ageText(0.5)).toBe('30 min ago');
    expect(ageText(36)).toBe('36 h ago');
    expect(ageText(96)).toBe('4 d ago');
  });
});

describe('coverageText', () => {
  const period = { periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-09-08T00:00:00.000Z' };
  it('names empty coverage instead of hiding it (spec 16.1)', () => {
    const text = coverageText({ sources: [], competitors: [], languages: [], ...period });
    expect(text).toContain('no sources yet');
    expect(text).toContain('no competitor monitoring');
    expect(text).toContain('no language filter');
  });
  it('lists sources, competitors and languages', () => {
    const text = coverageText({
      sources: ['reach', 'saves'],
      competitors: ['acme'],
      languages: ['en'],
      ...period,
    });
    expect(text).toContain('sources: reach, saves');
    expect(text).toContain('competitors: acme');
    expect(text).toContain('languages: en');
  });
  it('detects gaps from the evidence', () => {
    expect(hasCoverageGaps([{ evidence: [{ kind: 'metric_key' }] }])).toBe(false);
    expect(hasCoverageGaps([{ evidence: [{ kind: 'gap' }] }])).toBe(true);
  });
});

describe('insightLabel', () => {
  it('labels hypotheses and findings separately (spec 16.3)', () => {
    expect(insightLabel('association', 'observed')).toBe('Hypothesis');
    expect(insightLabel('experimental_finding', 'directional')).toBe('Hypothesis');
    expect(insightLabel('experimental_finding', 'experimentally_supported')).toBe('Finding');
    expect(insightLabel('anomaly', 'observed')).toBe('Anomaly');
    expect(insightLabel('change', 'observed')).toBe('Change');
  });
});

describe('canApprovePlaybook', () => {
  it('follows the spec 5.5 default grants', () => {
    expect(canApprovePlaybook('owner')).toBe(true);
    expect(canApprovePlaybook('brand_manager')).toBe(true);
    expect(canApprovePlaybook('analyst')).toBe(false);
    expect(canApprovePlaybook(null)).toBe(false);
  });
});

describe('levelChip and defaultReviewAfter', () => {
  it('shows unknown levels as text', () => {
    expect(levelChip('high').label).toBe('high');
    expect(levelChip('odd')).toEqual({ tone: 'neutral', label: 'odd' });
  });
  it('defaults the review date to 90 days ahead', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(defaultReviewAfter(now)).toBe('2026-04-01T00:00:00.000Z');
  });
});
