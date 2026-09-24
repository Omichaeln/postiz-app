import type {
  Completeness,
  MetricAggregateV1,
  MetricCoverageV1,
  MetricFreshness,
  MetricValueV1,
} from '@oremedia/contracts/measurement';

/**
 * Spec 15.2 normalisation rules as pure functions: aggregation only within a comparable_group, derived rates
 * carrying their numerator and denominator snapshot ids, series kept as series, freshness against the capability's
 * latency with stale at > latency × 2. No I/O; the service feeds rows in and presents what comes out.
 */

// ---- comparable groups (spec 15.1 / 15.2) ----

/**
 * Maps a provider-native metric name to a comparable_group. Platforms' "views", "impressions", "reach" and
 * "engagement" differ, so a group states what may be summed together; anything unrecognised stays its own group
 * (`other:<name>`) and is never aggregated with another provider's number.
 */
const GROUP_RULES: ReadonlyArray<[group: string, pattern: RegExp]> = [
  ['negative_feedback', /hide|unfollow|report|dislike|negative/i],
  ['saves', /save|bookmark/i],
  ['shares', /share|repost|retweet|resend|forward/i],
  ['comments', /comment|repl(y|ies)/i],
  ['likes', /like|reaction|favou?rite|heart/i],
  ['clicks', /click|tap/i],
  ['reach', /reach|unique/i],
  ['impressions', /impression|view|play/i],
  ['engagement', /engage/i],
  ['followers', /follow|subscriber/i],
  ['watch_time', /watch|retention|duration/i],
];

export function comparableGroupFor(nativeName: string): string {
  const leaf = nativeName.split('.').pop() ?? nativeName;
  for (const [group, pattern] of GROUP_RULES) if (pattern.test(leaf)) return group;
  return `other:${leaf.slice(0, 33)}`;
}

/** Retention-type and time-bucketed metrics are stored as series, never collapsed (spec 15.2). */
export const aggregationFor = (nativeName: string): 'sum' | 'max' | 'last' | 'avg' | 'series' =>
  /retention|series|timeline|daily|byDay|perDay/i.test(nativeName) ? 'series' : 'last';

/** Spec 15.2 derived rates: numerator group / denominator group, each carrying its snapshot ids. */
export const DERIVED_RATES: ReadonlyArray<{ key: string; numerator: string; denominator: string }> = [
  { key: 'engagement_rate', numerator: 'engagement', denominator: 'impressions' },
  { key: 'click_through_rate', numerator: 'clicks', denominator: 'impressions' },
  { key: 'save_rate', numerator: 'saves', denominator: 'impressions' },
];

export interface RateInput {
  snapshotId: string;
  comparableGroup: string;
  value: number | null;
  completeness: Completeness;
}
export interface DerivedRate {
  key: string;
  value: number | null;
  completeness: Completeness;
  numeratorSnapshotId: string;
  denominatorSnapshotId: string;
}

/**
 * Derives the rates that both operands exist for. An unavailable operand yields an unavailable rate (a row with
 * no value, never zero); a partial operand yields a partial rate; a zero denominator is unavailable.
 */
export function deriveRates(points: RateInput[]): DerivedRate[] {
  const byGroup = new Map<string, RateInput>();
  for (const p of points) if (!byGroup.has(p.comparableGroup)) byGroup.set(p.comparableGroup, p);
  const out: DerivedRate[] = [];
  for (const rate of DERIVED_RATES) {
    const n = byGroup.get(rate.numerator);
    const d = byGroup.get(rate.denominator);
    if (!n || !d) continue;
    const unavailable =
      n.completeness === 'unavailable' ||
      d.completeness === 'unavailable' ||
      n.value === null ||
      d.value === null ||
      d.value === 0;
    out.push({
      key: rate.key,
      value: unavailable ? null : (n.value as number) / (d.value as number),
      completeness: unavailable
        ? 'unavailable'
        : n.completeness === 'partial' || d.completeness === 'partial'
          ? 'partial'
          : 'complete',
      numeratorSnapshotId: n.snapshotId,
      denominatorSnapshotId: d.snapshotId,
    });
  }
  return out;
}

// ---- freshness (spec 15.2) ----

export const STALE_FACTOR = 2;

export function freshnessOf(fetchedAt: Date, latencyHours: number, now: Date): MetricFreshness {
  const ageHours = Math.max(0, (now.getTime() - fetchedAt.getTime()) / 3_600_000);
  return {
    fetchedAt: fetchedAt.toISOString(),
    ageHours: Math.round(ageHours * 100) / 100,
    latencyHours,
    stale: ageHours > latencyHours * STALE_FACTOR,
  };
}

// ---- selection and aggregation ----

/** The latest fetch per (subject, metric) wins; older fetches of the same window are history, not the number. */
export function latestPerSubjectMetric<T extends { subjectId: string; metricKey: string; fetchedAt: Date }>(
  rows: T[],
): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) {
    const k = `${row.subjectId}\u0000${row.metricKey}`;
    const prior = seen.get(k);
    if (!prior || row.fetchedAt.getTime() > prior.fetchedAt.getTime()) seen.set(k, row);
  }
  return [...seen.values()];
}

/**
 * Sums values within one comparable_group across subjects. Series are never aggregated (they stay series on the
 * values), unavailable rows count as unavailable subjects, and the aggregate is stale if any input is stale. Groups
 * never mix: a caller asking for impressions and reach gets two aggregates.
 */
export function aggregateByComparableGroup(values: MetricValueV1[]): MetricAggregateV1[] {
  const groups = new Map<string, MetricValueV1[]>();
  for (const v of values) {
    const list = groups.get(v.comparableGroup) ?? [];
    list.push(v);
    groups.set(v.comparableGroup, list);
  }
  const out: MetricAggregateV1[] = [];
  for (const [comparableGroup, list] of groups) {
    const scalar = list.filter((v) => v.series === null);
    const withData = scalar.filter((v) => v.value !== null && v.completeness !== 'unavailable');
    const unavailable = scalar.filter((v) => v.value === null || v.completeness === 'unavailable');
    const oldest = withData.reduce<MetricValueV1 | null>(
      (acc, v) => (!acc || v.freshness.fetchedAt < acc.freshness.fetchedAt ? v : acc),
      null,
    );
    out.push({
      comparableGroup,
      metricKeys: [...new Set(list.map((v) => v.metricKey))].sort(),
      value: withData.length === 0 ? null : withData.reduce((s, v) => s + (v.value as number), 0),
      snapshotIds: withData.map((v) => v.snapshotId),
      subjectsWithData: new Set(withData.map((v) => v.subjectId)).size,
      subjectsUnavailable: new Set(unavailable.map((v) => v.subjectId)).size,
      freshness: oldest ? oldest.freshness : null,
      stale: withData.some((v) => v.freshness.stale),
    });
  }
  return out.sort((a, b) => a.comparableGroup.localeCompare(b.comparableGroup));
}

export function coverageOf(
  values: MetricValueV1[],
  requested: { subjectIds: string[]; metricKeys: string[]; windowStart: Date; windowEnd: Date },
): MetricCoverageV1 {
  const withData = values.filter((v) => v.completeness !== 'unavailable' && (v.value !== null || v.series));
  const metricsWithData = [...new Set(withData.map((v) => v.metricKey))].sort();
  return {
    subjectsRequested: requested.subjectIds.length,
    subjectsWithData: new Set(withData.map((v) => v.subjectId)).size,
    metricsRequested: [...requested.metricKeys],
    metricsWithData,
    metricsUnavailable: requested.metricKeys.filter((k) => !metricsWithData.includes(k)),
    staleValues: values.filter((v) => v.freshness.stale).length,
    windowStart: requested.windowStart.toISOString(),
    windowEnd: requested.windowEnd.toISOString(),
  };
}
