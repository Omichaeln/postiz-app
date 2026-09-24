import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { NotFoundError } from '@oremedia/contracts/errors';
import type {
  CommentIngestionRuntimeV1,
  MetricCollectionRuntimeV1,
  PullCommentsInputV1,
  PullMetricsInputV1,
} from '@oremedia/contracts/measurement';
import { requireTenant } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { newId } from '@oremedia/domain/ids';
import { createCommentIngestionActivities } from './comment-ingestion';
import { createMetricCollectionActivities } from './metric-collection';

/**
 * The ingest activity hosts (spec 15.1, 16.5): tenant context from the input with grants re-loaded, the
 * per-activity heartbeat handed to the runtime (spec 20.3), a mismatched tenant refused before the runtime (so
 * before any credential is opened), a NOT_FOUND from the runtime surfaced as non-retryable PolicyDenied, and a
 * repeat of the same pull reaching the runtime with the same (publication, window) so the runtime's idempotency
 * per window applies.
 */
describe('metric collection and comment ingestion activities (MockActivityEnvironment against MySQL)', () => {
  let tdb: TestDatabase;
  const env = new MockActivityEnvironment();
  const run = <A, R>(fn: (arg: A) => Promise<R>, arg: A): Promise<R> => env.run(fn, arg) as Promise<R>;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const userA = newId('user');
  const seen: Array<{ method: string; tenantId: string; hooks: boolean; window?: string }> = [];
  const windows = new Set<string>();
  const collectionRuntime = (fail?: () => never): MetricCollectionRuntimeV1 => ({
    readCollectionPlan: async () => {
      seen.push({ method: 'readCollectionPlan', tenantId: requireTenant().tenantId, hooks: false });
      if (fail) fail();
      return {
        collectable: true,
        providerKey: 'fixture_provider',
        publishedAt: '2026-09-24T10:00:00.000Z',
        latencyHours: 1,
        commentsReadable: true,
      };
    },
    pullMetrics: async (i, hooks) => {
      hooks?.heartbeat(`from-runtime:pullMetrics:${i.pullIndex}`);
      const window = `${i.publicationId}|${i.windowStart}|${i.windowEnd}`;
      seen.push({
        method: 'pullMetrics',
        tenantId: requireTenant().tenantId,
        hooks: hooks !== undefined,
        window,
      });
      if (windows.has(window)) return { written: 0, skipped: 3, unavailable: 0 };
      windows.add(window);
      return { written: 3, skipped: 0, unavailable: 1 };
    },
  });
  const ingestionRuntime: CommentIngestionRuntimeV1 = {
    readCollectionPlan: collectionRuntime().readCollectionPlan,
    pullComments: async (_i, hooks) => {
      hooks?.heartbeat('from-runtime:pullComments');
      seen.push({ method: 'pullComments', tenantId: requireTenant().tenantId, hooks: hooks !== undefined });
      return { ingested: 1, duplicates: 0, nextCursor: null };
    },
  };
  const pull = (tenantId = tenantA): PullMetricsInputV1 => ({
    tenantId,
    actor: { kind: 'user', id: userA },
    correlationId: 'corr_ingest',
    publicationId: 'pub_1',
    pullIndex: 0,
    windowStart: '2026-09-24T10:00:00.000Z',
    windowEnd: '2026-09-24T11:00:00.000Z',
  });
  const comments = (tenantId = tenantA): PullCommentsInputV1 => ({
    tenantId,
    actor: { kind: 'user', id: userA },
    correlationId: 'corr_ingest',
    publicationId: 'pub_1',
    pullIndex: 0,
    since: null,
    cursor: null,
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'act-ingest-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'act-ingest-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db
      .insert(users)
      .values({ id: userA, email: `ingest-${userA.slice(-6).toLowerCase()}@example.test`, name: 'A' });
    await tdb.db.insert(memberships).values({
      id: newId('membership'),
      tenantId: tenantA,
      userId: userA,
      role: 'analyst',
      status: 'active',
      allBrands: true,
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('runs every ingest activity in tenant context with the heartbeat handed to the runtime', async () => {
    const acts = createMetricCollectionActivities(collectionRuntime());
    const comm = createCommentIngestionActivities(ingestionRuntime);
    const heartbeats: unknown[] = [];
    env.on('heartbeat', (d) => heartbeats.push(d));
    expect(await run(acts.readCollectionPlan, pull())).toMatchObject({ collectable: true });
    expect(await run(acts.pullMetrics, pull())).toEqual({ written: 3, skipped: 0, unavailable: 1 });
    expect(await run(comm.pullComments, comments())).toEqual({
      ingested: 1,
      duplicates: 0,
      nextCursor: null,
    });
    expect(seen.map((s) => s.method)).toEqual(['readCollectionPlan', 'pullMetrics', 'pullComments']);
    expect(seen.every((s) => s.tenantId === tenantA)).toBe(true);
    expect(seen.filter((s) => s.method !== 'readCollectionPlan').every((s) => s.hooks)).toBe(true);
    expect(heartbeats).toEqual([
      'metrics:pub_1:0:start',
      'from-runtime:pullMetrics:0',
      'comments:pub_1:0:start',
      'from-runtime:pullComments',
    ]);
  });

  it('a repeated pull of the same (publication, window) reaches the runtime identically and writes nothing new', async () => {
    seen.length = 0;
    const acts = createMetricCollectionActivities(collectionRuntime());
    expect(await run(acts.pullMetrics, pull())).toEqual({ written: 0, skipped: 3, unavailable: 0 });
    expect(await run(acts.pullMetrics, pull())).toEqual({ written: 0, skipped: 3, unavailable: 0 });
    expect(new Set(seen.map((s) => s.window)).size).toBe(1);
  });

  it('a mismatched tenantId is refused before the runtime (no credential is ever opened), non-retryably', async () => {
    seen.length = 0;
    const acts = createMetricCollectionActivities(collectionRuntime());
    const comm = createCommentIngestionActivities(ingestionRuntime);
    for (const bad of [pull(tenantB), pull(newId('tenant'))]) {
      const err = await run(acts.pullMetrics, bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).type).toBe('PolicyDenied');
      expect((err as ApplicationFailure).nonRetryable).toBe(true);
    }
    const err = await run(comm.pullComments, comments(tenantB)).catch((e: unknown) => e);
    expect((err as ApplicationFailure).type).toBe('PolicyDenied');
    expect(seen).toEqual([]);
  });

  it('a NOT_FOUND from the runtime (a foreign publication id) is a non-retryable PolicyDenied', async () => {
    const acts = createMetricCollectionActivities(
      collectionRuntime(() => {
        throw new NotFoundError('Publication', 'pub_x');
      }),
    );
    const err = await run(acts.readCollectionPlan, { ...pull(), publicationId: 'pub_x' }).catch(
      (e: unknown) => e,
    );
    expect((err as ApplicationFailure).type).toBe('PolicyDenied');
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });
});
