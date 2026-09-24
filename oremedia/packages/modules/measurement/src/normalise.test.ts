import { describe, expect, it } from 'vitest';
import type { MetricValueV1 } from '@oremedia/contracts/measurement';
import {
  STALE_FACTOR,
  aggregateByComparableGroup,
  aggregationFor,
  comparableGroupFor,
  coverageOf,
  deriveRates,
  freshnessOf,
  latestPerSubjectMetric,
} from './normalise';

const T0 = new Date('2026-09-24T10:00:00.000Z');
const value = (over: Partial<MetricValueV1>): MetricValueV1 => ({
  snapshotId: 'ms_1',
  subjectType: 'publication',
  subjectId: 'pub_1',
  metricKey: 'impressionCount',
  comparableGroup: 'impressions',
  value: 10,
  series: null,
  completeness: 'complete',
  freshness: freshnessOf(T0, 24, T0),
  source: 'linkedin_page@v1',
  definitionVersion: 1,
  windowStart: T0.toISOString(),
  windowEnd: T0.toISOString(),
  brandTimezone: 'UTC',
  numeratorSnapshotId: null,
  denominatorSnapshotId: null,
  ...over,
});

describe('normalisation rules (spec 15.2)', () => {
  it('maps provider-native names to comparable groups; unknown names stay their own group', () => {
    expect(comparableGroupFor('impressionCount')).toBe('impressions');
    expect(comparableGroupFor('uniqueImpressionsCount')).toBe('reach');
    expect(comparableGroupFor('totalShareStatistics.shareCount')).toBe('shares');
    expect(comparableGroupFor('saved')).toBe('saves');
    expect(comparableGroupFor('likeCount')).toBe('likes');
    expect(comparableGroupFor('hideCount')).toBe('negative_feedback');
    expect(comparableGroupFor('engagement')).toBe('engagement');
    expect(comparableGroupFor('somethingElse')).toBe('other:somethingElse');
  });
  it('retention-type metrics are series, never a single number', () => {
    expect(aggregationFor('audienceRetention')).toBe('series');
    expect(aggregationFor('followerGains.organicFollowerGain')).toBe('last');
  });
  it('derived rates carry numerator and denominator snapshot ids', () => {
    const rates = deriveRates([
      { snapshotId: 'ms_e', comparableGroup: 'engagement', value: 5, completeness: 'complete' },
      { snapshotId: 'ms_i', comparableGroup: 'impressions', value: 100, completeness: 'partial' },
      { snapshotId: 'ms_c', comparableGroup: 'clicks', value: null, completeness: 'unavailable' },
    ]);
    expect(rates).toEqual([
      {
        key: 'engagement_rate',
        value: 0.05,
        completeness: 'partial',
        numeratorSnapshotId: 'ms_e',
        denominatorSnapshotId: 'ms_i',
      },
      {
        key: 'click_through_rate',
        value: null,
        completeness: 'unavailable',
        numeratorSnapshotId: 'ms_c',
        denominatorSnapshotId: 'ms_i',
      },
    ]);
  });
  it('a zero denominator is unavailable, not Infinity, and a missing operand yields no rate', () => {
    expect(
      deriveRates([
        { snapshotId: 'a', comparableGroup: 'engagement', value: 3, completeness: 'complete' },
        { snapshotId: 'b', comparableGroup: 'impressions', value: 0, completeness: 'complete' },
      ]),
    ).toMatchObject([{ key: 'engagement_rate', value: null, completeness: 'unavailable' }]);
    expect(
      deriveRates([{ snapshotId: 'a', comparableGroup: 'saves', value: 3, completeness: 'complete' }]),
    ).toEqual([]);
  });
  it('freshness is stale beyond latency × 2', () => {
    const fresh = freshnessOf(T0, 24, new Date(T0.getTime() + 47 * 3_600_000));
    expect(fresh).toMatchObject({ ageHours: 47, latencyHours: 24, stale: false });
    const stale = freshnessOf(T0, 24, new Date(T0.getTime() + (24 * STALE_FACTOR + 1) * 3_600_000));
    expect(stale.stale).toBe(true);
    expect(freshnessOf(T0, 1, new Date(T0.getTime() + 3 * 3_600_000)).stale).toBe(true);
  });
  it('the latest fetch per (subject, metric) is the number', () => {
    const older = { subjectId: 'p', metricKey: 'm', fetchedAt: T0, id: 'old' };
    const newer = { subjectId: 'p', metricKey: 'm', fetchedAt: new Date(T0.getTime() + 1), id: 'new' };
    expect(latestPerSubjectMetric([newer, older]).map((r) => r.id)).toEqual(['new']);
    expect(latestPerSubjectMetric([older, newer]).map((r) => r.id)).toEqual(['new']);
  });
  it('aggregates only within a comparable group; unavailable rows count as unavailable subjects, never zero', () => {
    const agg = aggregateByComparableGroup([
      value({ snapshotId: 'a', subjectId: 'p1', metricKey: 'impressionCount', value: 10 }),
      value({ snapshotId: 'b', subjectId: 'p2', metricKey: 'impressions', value: 5, source: 'x@v1' }),
      value({
        snapshotId: 'c',
        subjectId: 'p3',
        metricKey: 'impressionCount',
        value: null,
        completeness: 'unavailable',
      }),
      value({
        snapshotId: 'd',
        subjectId: 'p1',
        metricKey: 'uniqueImpressionsCount',
        comparableGroup: 'reach',
        value: 7,
      }),
    ]);
    expect(agg).toEqual([
      expect.objectContaining({
        comparableGroup: 'impressions',
        value: 15,
        snapshotIds: ['a', 'b'],
        subjectsWithData: 2,
        subjectsUnavailable: 1,
      }),
      expect.objectContaining({ comparableGroup: 'reach', value: 7, subjectsWithData: 1 }),
    ]);
    expect(agg[0]?.metricKeys).toEqual(['impressionCount', 'impressions']);
  });
  it('series are never summed and an aggregate is stale when any input is', () => {
    const stale = freshnessOf(T0, 1, new Date(T0.getTime() + 10 * 3_600_000));
    const agg = aggregateByComparableGroup([
      value({ snapshotId: 'a', value: 10, freshness: stale }),
      value({
        snapshotId: 's',
        subjectId: 'p2',
        comparableGroup: 'watch_time',
        metricKey: 'audienceRetention',
        value: null,
        series: [{ at: '0', value: 1 }],
      }),
    ]);
    expect(agg.find((a) => a.comparableGroup === 'watch_time')).toMatchObject({
      value: null,
      snapshotIds: [],
    });
    expect(agg.find((a) => a.comparableGroup === 'impressions')?.stale).toBe(true);
  });
  it('coverage states what was asked, what came back and what is stale', () => {
    const cov = coverageOf(
      [
        value({ subjectId: 'p1', metricKey: 'impressionCount', value: 1 }),
        value({ subjectId: 'p2', metricKey: 'likeCount', value: null, completeness: 'unavailable' }),
      ],
      {
        subjectIds: ['p1', 'p2', 'p3'],
        metricKeys: ['impressionCount', 'likeCount', 'shareCount'],
        windowStart: T0,
        windowEnd: T0,
      },
    );
    expect(cov).toMatchObject({
      subjectsRequested: 3,
      subjectsWithData: 1,
      metricsWithData: ['impressionCount'],
      metricsUnavailable: ['likeCount', 'shareCount'],
      staleValues: 0,
    });
  });
});
