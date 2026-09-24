import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Observability from '@oremedia/observability';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { METRIC, record } from '@oremedia/observability';
import { outbox } from './outbox';
import {
  DEAD_LETTER_ATTEMPTS,
  backoffFor,
  dispatchBatch,
  listDeadLetters,
  oldestUndispatchedAgeMs,
  replayDeadLetter,
  type WorkflowStarter,
} from './outbox-dispatcher';
import { clearOutboxRoutes, registerOutboxRoute } from './outbox-routes';

vi.mock('@oremedia/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof Observability>();
  return { ...actual, record: vi.fn(actual.record) };
});

const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: 'usr_dispatch' },
  brandIds: 'all',
  correlationId: 'corr_dispatch',
});

class RecordingStarter implements WorkflowStarter {
  calls: Array<{ workflowId: string; workflowType: string; taskQueue: string; tenantId: string }> = [];
  failFor = new Set<string>();
  async start(req: Parameters<WorkflowStarter['start']>[0]): Promise<void> {
    if (this.failFor.has(req.workflowId)) throw new Error(`starter refused ${req.workflowId}`);
    this.calls.push({
      workflowId: req.workflowId,
      workflowType: req.workflowType,
      taskQueue: req.taskQueue,
      tenantId: req.tenantId,
    });
  }
}

describe('outbox dispatcher against MySQL 8 (spec 14.2)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');

  const emit = (tenantId: string, id: string) =>
    runInTenant(ctx(tenantId), () =>
      withTransaction(undefined, (tx) =>
        outbox.add(
          'asset.upload_completed',
          { type: 'upload_intent', id, version: 1 },
          { uploadIntentId: id },
          tx,
        ),
      ),
    );
  const row = async (id: string) => {
    const [r] = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.id, id));
    return r;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: 'ob-' + tenantA.slice(-6).toLowerCase() });
  });
  afterAll(async () => {
    await tdb?.drop();
  });
  afterEach(async () => {
    clearOutboxRoutes();
    await tdb.db.delete(outboxEvents);
  });

  it('claims ready events, starts the routed workflow with the stable id and marks them dispatched', async () => {
    registerOutboxRoute('asset.upload_completed', (evt) => ({
      workflowType: 'assetIngestWorkflowV1',
      taskQueue: 'media',
      workflowId: `ingest:${String(evt.payload['uploadIntentId'])}`,
      args: [evt.payload],
    }));
    const starter = new RecordingStarter();
    const id1 = await emit(tenantA, 'upl_1');
    const id2 = await emit(tenantA, 'upl_2');

    const summary = await dispatchBatch({ workerId: 'w1', starter });
    expect(summary).toEqual({ claimed: 2, dispatched: 2, ignored: 0, failed: 0 });
    expect(starter.calls.map((c) => c.workflowId).sort()).toEqual(['ingest:upl_1', 'ingest:upl_2']);
    expect(starter.calls[0]?.tenantId).toBe(tenantA);
    expect((await row(id1))?.dispatchedAt).toBeInstanceOf(Date);
    expect((await row(id2))?.dispatchedAt).toBeInstanceOf(Date);

    // A second pass finds nothing: dispatch is exactly-once per row.
    expect(await dispatchBatch({ workerId: 'w1', starter })).toEqual({
      claimed: 0,
      dispatched: 0,
      ignored: 0,
      failed: 0,
    });
    expect(starter.calls).toHaveLength(2);
  });

  it('marks informational events (no route, or a route returning null) dispatched without starting anything', async () => {
    const starter = new RecordingStarter();
    const id = await emit(tenantA, 'upl_info');
    const summary = await dispatchBatch({ workerId: 'w1', starter });
    expect(summary).toEqual({ claimed: 1, dispatched: 0, ignored: 1, failed: 0 });
    expect(starter.calls).toHaveLength(0);
    expect((await row(id))?.dispatchedAt).toBeInstanceOf(Date);
  });

  it('on failure records the error, increments attempts, releases the claim and backs off', async () => {
    registerOutboxRoute('asset.upload_completed', (evt) => ({
      workflowType: 'assetIngestWorkflowV1',
      taskQueue: 'media',
      workflowId: `ingest:${String(evt.payload['uploadIntentId'])}`,
      args: [],
    }));
    const starter = new RecordingStarter();
    starter.failFor.add('ingest:upl_fail');
    const id = await emit(tenantA, 'upl_fail');
    const before = new Date();
    const summary = await dispatchBatch({ workerId: 'w1', starter });
    expect(summary.failed).toBe(1);
    const r = await row(id);
    expect(r?.attempts).toBe(1);
    expect(r?.lastError).toContain('starter refused');
    expect(r?.claimedBy).toBeNull();
    expect(r?.dispatchedAt).toBeNull();
    // 5 s minimum backoff with ±10 % jitter, stored at whole-second precision.
    expect(r?.availableAt.getTime()).toBeGreaterThan(before.getTime() + 3_000);

    // Not claimable again until availableAt.
    expect((await dispatchBatch({ workerId: 'w2', starter })).claimed).toBe(0);
    // Once due, it is retried.
    starter.failFor.clear();
    const later = () => new Date(Date.now() + 20_000);
    expect(await dispatchBatch({ workerId: 'w2', starter, now: later })).toMatchObject({ dispatched: 1 });
  });

  it('re-claims an event whose lease expired with a dead worker', async () => {
    registerOutboxRoute('asset.upload_completed', () => ({
      workflowType: 'x',
      taskQueue: 'media',
      workflowId: 'ingest:lease',
      args: [],
    }));
    const starter = new RecordingStarter();
    const id = await emit(tenantA, 'upl_lease');
    await tdb.db
      .update(outboxEvents)
      .set({ claimedBy: 'dead-worker', claimExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(outboxEvents.id, id));
    // A live lease blocks other workers…
    await tdb.db
      .update(outboxEvents)
      .set({ claimedBy: 'live-worker', claimExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(outboxEvents.id, id));
    expect((await dispatchBatch({ workerId: 'w1', starter })).claimed).toBe(0);
    // …an expired one does not.
    await tdb.db
      .update(outboxEvents)
      .set({ claimedBy: 'dead-worker', claimExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(outboxEvents.id, id));
    expect((await dispatchBatch({ workerId: 'w1', starter })).dispatched).toBe(1);
  });

  it('two workers dispatching concurrently start each event exactly once', async () => {
    registerOutboxRoute('asset.upload_completed', (evt) => ({
      workflowType: 'x',
      taskQueue: 'media',
      workflowId: `ingest:${String(evt.payload['uploadIntentId'])}`,
      args: [],
    }));
    const starter = new RecordingStarter();
    const ids = await Promise.all(Array.from({ length: 12 }, (_, i) => emit(tenantA, `upl_c${i}`)));
    const results = await Promise.all([
      dispatchBatch({ workerId: 'wa', starter, batchSize: 5 }),
      dispatchBatch({ workerId: 'wb', starter, batchSize: 5 }),
      dispatchBatch({ workerId: 'wc', starter, batchSize: 5 }),
    ]);
    // Whatever the interleaving, every start is for a distinct event and no event is started twice.
    const started = starter.calls.map((c) => c.workflowId);
    expect(new Set(started).size).toBe(started.length);
    // Drain the remainder and check the total equals the number of events.
    let guard = 0;
    while ((await dispatchBatch({ workerId: 'wd', starter })).claimed > 0 && guard++ < 10) {
      /* drain */
    }
    expect(starter.calls).toHaveLength(ids.length);
    expect(results.reduce((n, r) => n + r.dispatched, 0) + 0).toBeLessThanOrEqual(ids.length);
    for (const id of ids) expect((await row(id))?.dispatchedAt).toBeInstanceOf(Date);
  });

  it('reports the oldest undispatched age and lists/replays dead letters', async () => {
    registerOutboxRoute('asset.upload_completed', () => ({
      workflowType: 'x',
      taskQueue: 'media',
      workflowId: 'ingest:dead',
      args: [],
    }));
    const starter = new RecordingStarter();
    starter.failFor.add('ingest:dead');
    const id = await emit(tenantA, 'upl_dead');
    expect(await oldestUndispatchedAgeMs()).toBeGreaterThanOrEqual(0);

    // Fail past the threshold, moving the clock so each backoff has elapsed.
    let clock = Date.now();
    for (let i = 0; i < DEAD_LETTER_ATTEMPTS; i++) {
      clock += 60 * 60 * 1000;
      const at = new Date(clock);
      expect((await dispatchBatch({ workerId: 'w1', starter, now: () => at })).failed).toBe(1);
    }
    const dead = await listDeadLetters();
    expect(dead.map((d) => d.id)).toEqual([id]);
    expect(dead[0]?.attempts).toBe(DEAD_LETTER_ATTEMPTS);

    starter.failFor.clear();
    expect(await replayDeadLetter(id)).toBe(true);
    expect((await dispatchBatch({ workerId: 'w1', starter })).dispatched).toBe(1);
    expect(await replayDeadLetter(id)).toBe(false); // already dispatched
    expect(await oldestUndispatchedAgeMs()).toBeNull();
  });

  it('spec 17.4 fairness: a bulk schedule of one tenant cannot fill the batch ahead of another tenant due at the same minute', async () => {
    registerOutboxRoute('asset.upload_completed', (evt) => ({
      workflowType: 'assetIngestWorkflowV1',
      taskQueue: 'media',
      workflowId: `ingest:${String(evt.payload['uploadIntentId'])}`,
      args: [],
    }));
    const tenantBulk = newId('tenant');
    const tenantSmall = newId('tenant');
    // The bulk tenant's 30 events are older than the small tenant's 2 (it scheduled first, for the same minute).
    for (let i = 0; i < 30; i++) await emit(tenantBulk, `upl_bulk_${i}`);
    await emit(tenantSmall, 'upl_small_0');
    await emit(tenantSmall, 'upl_small_1');
    const starter = new RecordingStarter();
    const first = await dispatchBatch({ workerId: 'w-fair', starter, batchSize: 10 });
    expect(first.claimed).toBe(10);
    const firstBatch = starter.calls.map((c) => c.tenantId);
    // Round-robin: both of the small tenant's events are in the first batch, and they are started first-and-third,
    // not after the bulk tenant's backlog.
    expect(firstBatch.filter((t) => t === tenantSmall)).toHaveLength(2);
    expect(firstBatch.slice(0, 4)).toEqual([tenantBulk, tenantSmall, tenantBulk, tenantSmall]);
    // Without the fair claim the oldest-first order would have been 10 bulk events.
    // The per-tenant cap bounds any one tenant's share of a batch even when it is the only one with work.
    for (let i = 0; i < 5; i++) await emit(tenantSmall, `upl_small_cap_${i}`);
    const capped = new RecordingStarter();
    await dispatchBatch({ workerId: 'w-cap', starter: capped, batchSize: 10, maxPerTenant: 3 });
    const perTenant = (t: string) => capped.calls.filter((c) => c.tenantId === t).length;
    expect(perTenant(tenantBulk)).toBe(3);
    expect(perTenant(tenantSmall)).toBe(3);
    // Spec 17.2 keeping up: the ready → start lag is recorded per dispatched event.
    expect(vi.mocked(record)).toHaveBeenCalledWith(METRIC.outboxDispatchLagMs, expect.any(Number), {
      eventType: 'asset.upload_completed',
    });
  });

  it('backoff doubles from 5 s and caps at 15 minutes', () => {
    const now = new Date(0);
    const fixed = () => 0.5; // no jitter
    expect(backoffFor(0, now, fixed).getTime()).toBe(5_000);
    expect(backoffFor(3, now, fixed).getTime()).toBe(40_000);
    expect(backoffFor(12, now, fixed).getTime()).toBe(15 * 60 * 1000);
  });
});
