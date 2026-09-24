import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { PublicationWorkflowInputV1, PublishProviderActivitiesV1 } from '@oremedia/contracts/publishing';
import { runInTenant, withTransaction } from '@oremedia/db';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { publicationAttempts, publications, remoteEvidence } from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createPublishControlActivities, createPublishProviderActivities } from '@oremedia/activities';
import { dispatchBatch, type WorkflowStarter } from '@oremedia/module-operations';
import {
  createPublishingRuntime,
  publicationService,
  type FixtureProviderAdapter,
} from '@oremedia/module-publishing';
import { runPublication, type PublicationHost } from '@oremedia/workflows/publication.workflow.v1';
import {
  configureBurstWorld,
  fireSchedules,
  openBurstLanes,
  prepareApproved,
  runLocalBurst,
  stats,
  type Lane,
} from '../../../tooling/load/local-burst';
import { seedTwoTenants } from '../../../tooling/test-fixtures/src/seed';

/**
 * Spec 19.1 "Operational" layer, the part that runs locally against MySQL 8 (ledger T.9), through the worker-core
 * composition root, the real modules, the real outbox dispatcher and the real publicationWorkflowV1 orchestration
 * with the fixture provider (a loopback platform):
 *
 *   (a) top-of-hour burst: tooling/load/local-burst.ts itself (runLocalBurst), at a size CI can afford;
 *   (b) queue fairness: one noisy tenant's many due publications against a quiet tenant's few, on a virtual clock
 *       where every workflow start costs a fixed time, so the quiet tenant's lateness bound is deterministic;
 *   (c) provider outage: failures before send retry from `scheduled` with no sentAt and publish once on recovery;
 *       a refusal at the send boundary (sentAt committed) and a reset after send are never blindly retried and
 *       reconcile with no duplicate post;
 *   (d) secret redaction on these outage paths: apps/worker-core/src/secret-scan.integration.test.ts ("outage
 *       paths"), which runs the same failures with provider errors that echo the access token and scans logs,
 *       workflow history and rows;
 *   (e) backup restore: apps/worker-core/src/runbooks.integration.test.ts ("restore a single tenant (7.11)") with
 *       `publishing.publications.holdRestored`, and the command's guarantees in
 *       packages/modules/publishing/src/publishing.integration.test.ts ("restore rule … holdRestored").
 *
 * Needs a live environment (open, not claimed here): the k6 run at 2–3× the expected peak against staging
 * (tooling/load/top-of-hour.js), real provider outages and rate limits, Temporal's own task-queue scheduling under
 * load, and a PITR restore into a separate instance.
 */
describe('operational suite (spec 19.1): burst, fairness, provider outage against MySQL 8', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  /** A lane's own publications (its brand; the seed leaves a scheduled publication on brand 1). */
  const ofLane = (lane: Lane) =>
    tdb.db
      .select()
      .from(publications)
      .where(and(eq(publications.tenantId, lane.tenant.tenantId), eq(publications.brandId, lane.brandId)));

  /** A fake Temporal host on a virtual clock: waits and sleeps advance it instead of blocking the test. */
  const virtualHost = (
    clock: { now: number },
    provider: PublishProviderActivitiesV1,
    workflowId: string,
  ): PublicationHost => ({
    workflowId,
    runId: '11111111-2222-3333-4444-888888888888',
    cancelRequested: () => false,
    takeRescheduled: () => false,
    now: () => clock.now,
    waitForSignal: async (ms) => {
      clock.now += ms;
    },
    sleep: async (ms) => {
      clock.now += typeof ms === 'number' ? ms : 60_000;
    },
    providerActivities: () => ({ publish: provider, lookup: provider }),
  });

  it('(a) top-of-hour burst at CI size: every publication of every tenant reaches a terminal state, none fails to schedule, the worst lateness is within the SLO', async () => {
    const report = await runLocalBurst(tdb, {
      total: 40,
      bulkShare: 0.7,
      coreConcurrency: 8,
      startLatencyMs: 2,
      batchSize: 20,
      leadSeconds: 25,
    });
    expect(report.errors).toBe(0);
    expect(report.lanes).toHaveLength(4);
    for (const lane of report.lanes) {
      expect(lane.states, lane.tenant.tenantId).toEqual({ published: lane.prepared.length });
      expect(lane.latenessMs).toHaveLength(lane.prepared.length);
    }
    expect(report.lanes.reduce((n, l) => n + l.prepared.length, 0)).toBe(40);
    expect(report.worstLatenessMs).toBeLessThanOrEqual(60_000); // spec 17.2 dispatch lateness p99 < 60 s
  }, 180_000);

  it("(b) queue fairness: a noisy tenant's 40 due publications cannot starve a quiet tenant's 3 due the same minute", async () => {
    const NOISY = 40;
    const QUIET = 3;
    /** A saturated core worker: each workflow start and run costs this much of the virtual clock. */
    const START_COST_MS = 1_000;
    const { tenantA, tenantB } = await seedTwoTenants(tdb.db);
    configureBurstWorld();
    const [noisy, quiet] = (await openBurstLanes([tenantA, tenantB])) as [Lane, Lane];
    const at = new Date(Math.ceil((Date.now() + 60_000) / 1000) * 1000);
    await prepareApproved(noisy, NOISY, at, 'noisy');
    await prepareApproved(quiet, QUIET, at, 'quiet');
    // Only the burst is queued: everything the preparation emitted is dispatched first.
    const drain: WorkflowStarter = { start: async () => undefined };
    while ((await dispatchBatch({ workerId: 'fair-drain', starter: drain })).claimed);
    // The noisy tenant schedules first, so every one of its starts is older than the quiet tenant's.
    await fireSchedules([noisy], at);
    await fireSchedules([quiet], at);
    expect(noisy.errors + quiet.errors).toBe(0);

    const clock = { now: Math.max(at.getTime(), Date.now() + 1_000) }; // the minute has come; all are due
    const offset = clock.now - at.getTime();
    const runtime = createPublishingRuntime({ now: () => new Date(clock.now) });
    const control = createPublishControlActivities(runtime.control);
    const provider = createPublishProviderActivities(runtime.provider);
    const started: string[] = [];
    const starter: WorkflowStarter = {
      async start(req) {
        if (req.workflowType !== 'publicationWorkflowV1') return;
        started.push(req.tenantId);
        clock.now += START_COST_MS;
        const input = req.args[0] as PublicationWorkflowInputV1;
        await runPublication(control, input, virtualHost(clock, provider, req.workflowId));
      },
    };
    while (
      (await dispatchBatch({ workerId: 'fair', starter, batchSize: 10, now: () => new Date(clock.now) }))
        .claimed
    );

    expect(started).toHaveLength(NOISY + QUIET);
    // The fair claim interleaves tenants: the quiet tenant's starts are among the first 2 × QUIET, not after the
    // noisy backlog (oldest-first order would have put them at 41–43).
    const quietPositions = started.flatMap((t, i) => (t === tenantB.tenantId ? [i + 1] : []));
    expect(quietPositions).toHaveLength(QUIET);
    expect(Math.max(...quietPositions)).toBeLessThanOrEqual(2 * QUIET);
    // Dispatch lateness (claim − scheduled time, spec 17.2), from the rows.
    const lateness = async (lane: Lane) =>
      (await ofLane(lane)).map((p) => p.claimedAt!.getTime() - p.scheduledFor.getTime());
    const quietLate = stats(await lateness(quiet));
    const noisyLate = stats(await lateness(noisy));
    expect(quietLate.n).toBe(QUIET);
    expect(quietLate.max).toBeLessThanOrEqual(offset + 2 * QUIET * START_COST_MS);
    // The load was real: the noisy tenant's own tail waited behind its own backlog.
    expect(noisyLate.max).toBeGreaterThanOrEqual(offset + NOISY * START_COST_MS);
    for (const l of [noisy, quiet])
      expect(new Set((await ofLane(l)).map((p) => p.state))).toEqual(new Set(['published']));
  }, 180_000);

  describe('(c) provider outage', () => {
    let fixture: FixtureProviderAdapter;
    let lane: Lane;
    const clock = { now: 0 };
    let control: ReturnType<typeof createPublishControlActivities>;
    let provider: ReturnType<typeof createPublishProviderActivities>;
    let at = new Date();

    const wfInput = (publicationId: string): PublicationWorkflowInputV1 => ({
      tenantId: lane.tenant.tenantId,
      actor: { kind: 'user', id: lane.tenant.ownerUserId },
      correlationId: 'corr_outage',
      publicationId,
    });
    /** Schedules `count` approved posts for `at` and returns their ids and captions. */
    const schedule = async (count: number, label: string) => {
      const before = new Set((await ofLane(lane)).map((p) => p.id));
      lane.prepared = [];
      await prepareApproved(lane, count, at, label);
      await fireSchedules([lane], at);
      expect(lane.errors).toBe(0);
      return (await ofLane(lane)).filter((p) => !before.has(p.id)).map((p) => p.id);
    };
    /** Remote posts on the fixture platform for one publication (each carries its attempt's idempotency key). */
    const postsFor = async (publicationId: string) => {
      const keys = new Set((await attemptsOf(publicationId)).map((a) => a.providerIdempotencyKey));
      return fixture.posts.filter((p) => keys.has(p.idempotencyKey));
    };
    const attemptsOf = (publicationId: string) =>
      tdb.db
        .select()
        .from(publicationAttempts)
        .where(eq(publicationAttempts.publicationId, publicationId))
        .orderBy(publicationAttempts.attemptNumber);
    const statesOf = async (publicationId: string) =>
      (
        await tdb.db
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.eventType, 'publication.state_changed'),
              eq(outboxEvents.aggregateId, publicationId),
            ),
          )
          .orderBy(outboxEvents.aggregateVersion)
      ).map((e) => String(e.payload['toState']));

    beforeAll(async () => {
      const { tenantA } = await seedTwoTenants(tdb.db);
      fixture = configureBurstWorld();
      [lane] = (await openBurstLanes([tenantA])) as [Lane];
      at = new Date(Math.floor(Date.now() / 1000) * 1000); // due now
      clock.now = Date.now();
      const runtime = createPublishingRuntime({ now: () => new Date(clock.now) });
      control = createPublishControlActivities(runtime.control);
      provider = createPublishProviderActivities(runtime.provider);
    }, 60_000);

    it('down before send for three minutes: every attempt in the outage retries from scheduled with no sentAt; each post publishes once after recovery', async () => {
      const ids = await schedule(3, 'before-send outage');
      const outageUntil = clock.now + 3 * 60_000;
      const publish = fixture.publish.bind(fixture);
      fixture.publish = async (req, creds, io) => {
        fixture.behaviour = clock.now < outageUntil ? { kind: 'before_send_failure' } : { kind: 'accept' };
        return publish(req, creds, io);
      };
      try {
        for (const id of ids)
          await runPublication(control, wfInput(id), virtualHost(clock, provider, `pub:${id}`));
      } finally {
        fixture.publish = publish;
        fixture.behaviour = { kind: 'accept' };
      }
      expect(clock.now).toBeGreaterThanOrEqual(outageUntil); // the outage really lasted
      // The publication that was due first lived through the outage: several attempts, all but the last failed
      // before send; the ones behind it went out after recovery.
      expect((await attemptsOf(ids[0]!)).length).toBeGreaterThan(2);
      for (const id of ids) {
        const attempts = await attemptsOf(id);
        for (const failed of attempts.slice(0, -1))
          expect(failed).toMatchObject({ outcome: 'retryable_error', sentAt: null });
        expect(attempts.at(-1)).toMatchObject({ outcome: 'accepted' });
        expect(attempts.at(-1)!.sentAt).not.toBeNull();
        const states = await statesOf(id);
        expect(states.filter((s) => s === 'scheduled').length).toBe(attempts.length - 1); // retried from scheduled
        expect(states).not.toContain('outcome_unknown');
        expect(states.at(-1)).toBe('published');
        expect(await postsFor(id)).toHaveLength(1);
      }
    });

    it('a reset after send goes outcome_unknown and reconciles to the one post; a refusal at the send boundary is never blindly retried: absence is proven, a person re-releases, one post', async () => {
      const [afterSend, boundary] = (await schedule(2, 'after-send outage')) as [string, string];
      // The fixture platform stamps posts with the wall clock and scans from the attempt's start: start in step.
      clock.now = Date.now();
      // After send: the platform has the post, the response is lost.
      fixture.behaviour = { kind: 'after_send_failure' };
      await runPublication(control, wfInput(afterSend), virtualHost(clock, provider, `pub:${afterSend}`));
      fixture.behaviour = { kind: 'accept' };
      expect(await attemptsOf(afterSend)).toHaveLength(1);
      expect((await attemptsOf(afterSend))[0]!.sentAt).not.toBeNull();
      expect(await statesOf(afterSend)).toEqual(['dispatching', 'outcome_unknown', 'published']);
      const evidence = await tdb.db
        .select()
        .from(remoteEvidence)
        .where(eq(remoteEvidence.publicationId, afterSend));
      expect(evidence.map((e) => e.kind)).toEqual(['reconciliation']);
      expect(await postsFor(afterSend)).toHaveLength(1);

      // At the boundary: sentAt is committed, then the connection is refused. The ledger says "maybe sent", so no
      // automatic retry: reconciliation looks, proves absence (retry_eligible), a person re-releases.
      fixture.behaviour = { kind: 'unreachable' };
      await runPublication(control, wfInput(boundary), virtualHost(clock, provider, `pub:${boundary}`));
      fixture.behaviour = { kind: 'accept' };
      const [first] = await attemptsOf(boundary);
      expect(first!.sentAt).not.toBeNull();
      expect(
        (await tdb.db.select().from(publications).where(eq(publications.id, boundary)))[0],
      ).toMatchObject({
        state: 'retry_eligible',
      });
      expect(await statesOf(boundary)).toEqual(['dispatching', 'outcome_unknown', 'retry_eligible']);
      const row = (await tdb.db.select().from(publications).where(eq(publications.id, boundary)))[0]!;
      await runInTenant(
        {
          tenantId: lane.tenant.tenantId,
          actor: { kind: 'user', id: lane.tenant.ownerUserId },
          brandIds: 'all',
          correlationId: 'corr_outage',
        },
        () =>
          withTransaction((tx) =>
            publicationService.reschedule(
              lane.owner,
              {
                publicationId: boundary,
                expectedVersion: row.version,
                scheduledFor: new Date(clock.now).toISOString(),
              },
              tx,
            ),
          ),
      );
      await runPublication(control, wfInput(boundary), virtualHost(clock, provider, `pub:${boundary}:r`));
      expect((await tdb.db.select().from(publications).where(eq(publications.id, boundary)))[0]!.state).toBe(
        'published',
      );
      expect(await attemptsOf(boundary)).toHaveLength(2);
      expect(await postsFor(boundary)).toHaveLength(1);
      // Nothing of this tenant was published twice.
      const published = await tdb.db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.tenantId, lane.tenant.tenantId),
            inArray(publications.id, [afterSend, boundary]),
          ),
        );
      expect(published.map((p) => p.state)).toEqual(['published', 'published']);
    });
  });
});
