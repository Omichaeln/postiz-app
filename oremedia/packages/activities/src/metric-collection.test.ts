import { describe, expect, it, vi } from 'vitest';
import type * as Observability from '@oremedia/observability';
import type { MetricCollectionRuntimeV1 } from '@oremedia/contracts/measurement';
import { METRIC, record } from '@oremedia/observability';
import { createMetricCollectionActivities } from './metric-collection';

vi.mock('@oremedia/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof Observability>();
  return { ...actual, record: vi.fn() };
});
// The tenant host re-loads grants from the database; here it only runs the body (the runtime is a fake).
vi.mock('./tenant', () => ({
  inTenant: (_input: unknown, _grants: unknown, fn: () => Promise<unknown>) => fn(),
  heartbeat: () => undefined,
}));

describe('metric collection activities: ingest lag (spec 17.2 ingest journey, docs/operations/slos.md)', () => {
  it('records oremedia.measurement.ingest_lag_ms from the window end to the finished pull', async () => {
    const runtime: MetricCollectionRuntimeV1 = {
      readCollectionPlan: async () => ({
        collectable: true,
        providerKey: 'fixture_provider',
        publishedAt: null,
        latencyHours: 1,
        commentsReadable: false,
      }),
      pullMetrics: async () => ({ written: 3, skipped: 0, unavailable: 0 }),
    };
    const acts = createMetricCollectionActivities(runtime);
    const windowEnd = new Date(Date.now() - 90_000).toISOString();
    const result = await acts.pullMetrics({
      tenantId: 'ten_A',
      actor: { kind: 'user', id: 'usr_1' },
      correlationId: 'c',
      publicationId: 'pub_1',
      pullIndex: 0,
      windowStart: new Date(Date.now() - 3_600_000).toISOString(),
      windowEnd,
    });
    expect(result.written).toBe(3);
    const call = vi.mocked(record).mock.calls.find(([name]) => name === METRIC.ingestLagMs)!;
    expect(call).toBeDefined();
    expect(call[1]).toBeGreaterThanOrEqual(90_000);
    expect(call[2]).toEqual({ outcome: 'written' });
  });
});
