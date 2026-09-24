import { describe, expect, it } from 'vitest';
import type {
  CollectionPlanV1,
  MetricCollectionActivitiesV1,
  PullMetricsInputV1,
} from '@oremedia/contracts/measurement';
import { ApplicationFailure } from '@temporalio/common';
import {
  BASE_PULL_OFFSETS_MS,
  HORIZON_MS,
  WEEKLY_MS,
  collectionSchedule,
  runMetricCollection,
} from './metric-collection.workflow.v1';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const input = {
  tenantId: 'ten_A',
  actor: { kind: 'user' as const, id: 'usr_1' },
  correlationId: 'c',
  publicationId: 'pub_1',
};
const PUBLISHED_AT = Date.parse('2026-09-24T10:00:00.000Z');

function fakes(plan: Partial<CollectionPlanV1> = {}, failAt: number[] = []) {
  const pulls: PullMetricsInputV1[] = [];
  const sleeps: number[] = [];
  const started: string[] = [];
  let clock = PUBLISHED_AT + 5 * 60_000; // the outbox delivered five minutes after publication
  const acts: MetricCollectionActivitiesV1 = {
    readCollectionPlan: async () => ({
      collectable: true,
      providerKey: 'fixture_provider',
      publishedAt: new Date(PUBLISHED_AT).toISOString(),
      latencyHours: 1,
      commentsReadable: false,
      ...plan,
    }),
    pullMetrics: async (i) => {
      pulls.push(i);
      if (failAt.includes(i.pullIndex)) throw ApplicationFailure.nonRetryable('denied', 'PolicyDenied');
      return { written: 1, skipped: 0, unavailable: 0 };
    },
  };
  const host = {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    startCommentIngestion: async (i: typeof input) => {
      started.push(i.publicationId);
    },
  };
  return { acts, host, pulls, sleeps, started, clock: () => clock };
}

describe('metricCollectionWorkflowV1 schedule (spec 15.1)', () => {
  it('pulls at +1h, +24h, +72h, +7d, +28d, then weekly to the 90-day horizon', () => {
    const s = collectionSchedule(1);
    expect(s.slice(0, 5)).toEqual([...BASE_PULL_OFFSETS_MS]);
    expect(s.slice(5)).toEqual([35, 42, 49, 56, 63, 70, 77, 84].map((d) => d * DAY).concat(HORIZON_MS));
    for (let i = 6; i < s.length - 1; i++) expect(s[i]! - s[i - 1]!).toBe(WEEKLY_MS);
    expect(s[s.length - 1]).toBe(90 * DAY);
    expect(s).toHaveLength(14);
  });
  it('a platform that reports late (latencyHours 24) pushes the early pulls to the latency and merges them', () => {
    const s = collectionSchedule(24);
    expect(s[0]).toBe(24 * HOUR); // the +1h pull cannot be earlier than the data
    expect(s.filter((o) => o === 24 * HOUR)).toHaveLength(1);
    expect(s).toEqual([
      24 * HOUR,
      72 * HOUR,
      7 * DAY,
      28 * DAY,
      ...[35, 42, 49, 56, 63, 70, 77, 84, 90].map((d) => d * DAY),
    ]);
  });
  it('sleeps until each due moment and pulls with the cumulative UTC window since publication', async () => {
    const f = fakes();
    const outcome = await runMetricCollection(f.acts, input, f.host);
    expect(outcome).toEqual({ outcome: 'collected', pulls: 14, failed: 0, commentsStarted: false });
    expect(f.sleeps[0]).toBe(HOUR - 5 * 60_000);
    expect(f.sleeps[1]).toBe(23 * HOUR);
    expect(f.sleeps.reduce((a, b) => a + b, 0)).toBe(HORIZON_MS - 5 * 60_000);
    expect(f.pulls.map((p) => p.pullIndex)).toEqual([...Array(14).keys()]);
    expect(f.pulls.every((p) => p.windowStart === new Date(PUBLISHED_AT).toISOString())).toBe(true);
    expect(f.pulls.map((p) => Date.parse(p.windowEnd) - PUBLISHED_AT)).toEqual(collectionSchedule(1));
    expect(f.pulls[0]).toMatchObject({ tenantId: 'ten_A', publicationId: 'pub_1', actor: input.actor });
  });
  it('a workflow started late does not sleep for pulls already due, and still makes them', async () => {
    const f = fakes();
    f.host.now = () => PUBLISHED_AT + 8 * DAY;
    const sleeps: number[] = [];
    f.host.sleep = async (ms) => {
      sleeps.push(ms);
    };
    await runMetricCollection(f.acts, input, f.host);
    expect(f.pulls).toHaveLength(14);
    expect(sleeps).toHaveLength(14 - 4); // +1h, +24h, +72h, +7d were due already
  });
  it('a publication that is not published collects nothing', async () => {
    const f = fakes({ collectable: false });
    expect(await runMetricCollection(f.acts, input, f.host)).toMatchObject({ outcome: 'not_collectable' });
    expect(f.pulls).toEqual([]);
  });
  it('starts the comment ingestion child on its own queue when the capability reads comments', async () => {
    const f = fakes({ commentsReadable: true });
    expect(await runMetricCollection(f.acts, input, f.host)).toMatchObject({ commentsStarted: true });
    expect(f.started).toEqual(['pub_1']);
  });
  it('a permanently failing pull is counted and the rest of the schedule continues', async () => {
    const f = fakes({}, [2]);
    expect(await runMetricCollection(f.acts, input, f.host)).toMatchObject({ pulls: 13, failed: 1 });
    expect(f.pulls).toHaveLength(14);
  });
});
