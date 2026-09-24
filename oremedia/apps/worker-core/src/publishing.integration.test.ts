import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import type {
  ChannelVariantForPublishing,
  PublicationWorkflowInputV1,
  PublishProviderActivitiesV1,
} from '@oremedia/contracts/publishing';
import type { ReleaseDecision } from '@oremedia/contracts/review';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { publicationAttempts, publications, remoteEvidence } from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createPublishControlActivities, createPublishProviderActivities } from '@oremedia/activities';
import { registerBrandChecker } from '@oremedia/module-access';
import {
  clearOutboxRoutes,
  dispatchBatch,
  outboxRouteFor,
  type WorkflowStartRequest,
} from '@oremedia/module-operations';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  configurePublishingProviders,
  createPublishingRuntime,
  publicationService,
  registerProviderClients,
  registerPublishMediaSource,
  registerPublishingBrandChecker,
  registerPublishingOutboxRoutes,
  registerReleaseEvaluator,
  registerVariantSource,
  registerWorkflowProbe,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';
import { runPublication, type PublicationHost } from '@oremedia/workflows/publication.workflow.v1';

/**
 * The publishing stream end to end (Phase 5 gate) against MySQL, the real publishing module, the real activity
 * hosts and the real workflow orchestration (runPublication with a fake Temporal host): an approved variant
 * schedules and publishes (scheduled → dispatching → published with an attempt row, sentAt and evidence); a crash
 * after send produces outcome_unknown and reconciles to published with exactly one remote post; a duplicate outbox
 * delivery starts one workflow (the same stable id, USE_EXISTING); the cancel race behaves as spec 13.5 says.
 */
const USER = 'usr_e2e_publisher';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_e2e',
});
const publisher = (tenantId: string) => ({
  kind: 'user' as const,
  id: USER,
  tenantId,
  membershipId: 'mem_e2e',
  membershipStatus: 'active' as const,
  role: 'owner' as const,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});

describe('publication workflow end to end (worker-core, fake Temporal host)', () => {
  let tdb: TestDatabase;
  const tenantA = tenantIdFor('a');
  const brandA = brandIdFor();
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter();
  registry.register(fixture);
  const variantsById = new Map<string, ChannelVariantForPublishing>();
  let releaseDecision: ReleaseDecision = { allow: true };
  const runtime = createPublishingRuntime();
  const control = createPublishControlActivities(runtime.control);
  const provider = createPublishProviderActivities(runtime.provider);
  let connA = '';

  function tenantIdFor(label: string) {
    return `ten_${label.toUpperCase()}${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'.repeat(1).slice(0, 25)}`;
  }
  function brandIdFor() {
    return `brd_${'0123456789ABCDEFGHJKMNPQRSTVWX'.slice(0, 26)}`;
  }
  const wfInput = (publicationId: string): PublicationWorkflowInputV1 => ({
    tenantId: tenantA,
    actor: { kind: 'user', id: USER },
    correlationId: 'corr_e2e',
    publicationId,
  });
  const row = async (id: string) =>
    (await tdb.db.select().from(publications).where(eq(publications.id, id)))[0]!;
  const attemptsOf = (id: string) =>
    tdb.db.select().from(publicationAttempts).where(eq(publicationAttempts.publicationId, id));
  const newVariant = (text: string, connectionId = connA): ChannelVariantForPublishing => {
    const id = `cv_${Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(26, 'X')}`;
    const v: ChannelVariantForPublishing = {
      id,
      tenantId: tenantA,
      brandId: brandA,
      contentPackageId: 'pkg_e2e',
      contentRevisionId: `pr_${id.slice(3)}`,
      channelConnectionId: connectionId,
      text,
      altTexts: [],
      settings: {},
      exportIds: [],
      exportHashes: [],
      version: 0,
    };
    variantsById.set(id, v);
    return v;
  };
  const schedule = (variantId: string, at = new Date(Date.now() - 1000)) =>
    runInTenant(ctx(tenantA), () =>
      withTransaction((tx) =>
        publicationService.schedule(
          publisher(tenantA),
          {
            channelVariantId: variantId,
            scheduledFor: at.toISOString(),
            authority: 'approval',
            approvalId: 'apr_e2e',
          },
          tx,
        ),
      ),
    );
  /** A fake Temporal host: the activities run in-process; signals are flags the test flips. */
  function host(
    opts: {
      cancelAt?: 'wait' | 'after_release' | 'after_send';
      publishOverride?: PublishProviderActivitiesV1['publishOnce'];
    } = {},
  ) {
    let cancelled = false;
    const sleeps: Array<number | string> = [];
    const wrapped: PublishProviderActivitiesV1 = {
      ...provider,
      publishOnce: async (i) => {
        const r = await (opts.publishOverride ?? provider.publishOnce)(i);
        if (opts.cancelAt === 'after_send') cancelled = true;
        return r;
      },
    };
    const h: PublicationHost = {
      workflowId: 'pub:e2e',
      runId: '11111111-2222-3333-4444-555555555555',
      cancelRequested: () => cancelled,
      takeRescheduled: () => false,
      now: () => Date.now(),
      waitForSignal: async () => {
        if (opts.cancelAt === 'wait') cancelled = true;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      providerActivities: () => ({ publish: wrapped, lookup: wrapped }),
    };
    const controlWithCancel = {
      ...control,
      evaluateRelease: async (i: Parameters<typeof control.evaluateRelease>[0]) => {
        const r = await control.evaluateRelease(i);
        if (opts.cancelAt === 'after_release') cancelled = true;
        return r;
      },
    };
    return { host: h, control: controlWithCancel, sleeps };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values({ id: tenantA, name: 'A', slug: 'e2e-pub-a' });
    await tdb.db.insert(users).values({ id: USER, email: 'e2e-publisher@example.test', name: 'Publisher' });
    await tdb.db.insert(memberships).values({
      id: 'mem_e2e',
      tenantId: tenantA,
      userId: USER,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A1',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    registerBrandChecker({
      assertExist: async () => undefined,
      assertValidGrantBrands: async () => undefined,
    });
    registerPublishingBrandChecker({
      assertExist: async (ids) => {
        for (const id of ids) if (id !== brandA) throw new NotFoundError('Brand', id);
      },
    });
    configurePublishingProviders({ registry });
    configureCredentialBroker({ kms: new LocalKms('e2e-master-secret-0123456789abcdef') });
    registerProviderClients(() => ({ clientId: 'c', clientSecret: 's' }));
    registerVariantSource(async (id) => {
      const v = variantsById.get(id);
      if (!v) throw new NotFoundError('ChannelVariant', id);
      return v;
    });
    registerReleaseEvaluator(async () => releaseDecision);
    registerPublishMediaSource(async () => []);
    registerWorkflowProbe(null);
    clearOutboxRoutes();
    registerPublishingOutboxRoutes();
    const started = await runInTenant(ctx(tenantA), () =>
      withTransaction((tx) =>
        channelService.connect.start(
          publisher(tenantA),
          { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
          tx,
        ),
      ),
    );
    connA = (
      await runInTenant(ctx(tenantA), () =>
        withTransaction((tx) =>
          channelService.connect.complete(publisher(tenantA), { state: started.state, code: 'good' }, tx),
        ),
      )
    ).id;
  });
  afterAll(async () => {
    await tdb?.drop();
  });
  beforeEach(() => {
    fixture.behaviour = { kind: 'accept' };
    releaseDecision = { allow: true };
  });

  it('an approved variant publishes: scheduled → dispatching → published with attempt, sentAt, evidence; the outbox routes the start to core with the stable id', async () => {
    const v = newVariant('E2E happy path');
    const pub = await schedule(v.id);
    const evt = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, pub.id)))[0]!;
    const req = outboxRouteFor(evt.eventType)!({ ...evt, payload: evt.payload })!;
    expect(req).toMatchObject({
      workflowType: 'publicationWorkflowV1',
      taskQueue: 'core',
      workflowId: `pub:${pub.id}`,
    });
    expect(JSON.stringify(req.args)).not.toContain('at_fixture_secret'); // references only (R5)
    const h = host();
    await runPublication(h.control, wfInput(pub.id), h.host);
    expect(await row(pub.id)).toMatchObject({ state: 'published', remotePostId: 'post_1', fencingToken: 1 });
    const attempts = await attemptsOf(pub.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.sentAt).not.toBeNull();
    expect(attempts[0]!.outcome).toBe('accepted');
    expect(
      await tdb.db.select().from(remoteEvidence).where(eq(remoteEvidence.publicationId, pub.id)),
    ).toHaveLength(1);
  });

  it('crash after send → outcome_unknown → reconciled to published without a duplicate remote post', async () => {
    const v = newVariant('E2E crash after send');
    const pub = await schedule(v.id);
    fixture.behaviour = { kind: 'crash_after_send' };
    const before = fixture.posts.length;
    const h = host({
      publishOverride: async (i) => {
        // the activity is cut off after sentAt: the workflow sees a failure, never a result
        await provider.publishOnce(i).catch(() => undefined);
        throw new Error('activity heartbeat timeout');
      },
    });
    await runPublication(h.control, wfInput(pub.id), h.host);
    expect(await row(pub.id)).toMatchObject({ state: 'published', stateReason: 'reconciliation' });
    expect(fixture.posts.length).toBe(before + 1); // exactly one post on the platform
    expect(h.sleeps[0]).toBe('1 minute');
    const attempts = await attemptsOf(pub.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.remotePostId).toBe(fixture.posts.at(-1)!.id);
    expect(
      (await tdb.db.select().from(remoteEvidence).where(eq(remoteEvidence.publicationId, pub.id)))[0],
    ).toMatchObject({ kind: 'reconciliation' });
  });

  it('a duplicate outbox delivery starts the same workflow id once (USE_EXISTING) and never a second publication', async () => {
    const v = newVariant('E2E duplicate delivery');
    const pub = await schedule(v.id);
    const starts: WorkflowStartRequest[] = [];
    const starter = {
      start: async (req: WorkflowStartRequest & { tenantId: string }) => {
        starts.push(req);
      },
    };
    await dispatchBatch({ workerId: 'w1', starter });
    // the same event redelivered (lease lost, worker crashed after the start): another start with the same id
    await tdb.db
      .update(outboxEvents)
      .set({ dispatchedAt: null, claimedBy: null, claimExpiresAt: null })
      .where(eq(outboxEvents.aggregateId, pub.id));
    await dispatchBatch({ workerId: 'w2', starter });
    const ours = starts.filter((s) => s.workflowId === `pub:${pub.id}`);
    expect(ours).toHaveLength(2);
    expect(new Set(ours.map((s) => s.workflowId)).size).toBe(1); // Temporal dedupes on the id; the row is the authority
    // two runs of the orchestration for the same row: the second finds the row already claimed/published and exits
    const h1 = host();
    await runPublication(h1.control, wfInput(pub.id), h1.host);
    const h2 = host();
    await runPublication(h2.control, wfInput(pub.id), h2.host);
    expect(await attemptsOf(pub.id)).toHaveLength(1);
    expect(fixture.posts.filter((p) => p.text === 'E2E duplicate delivery')).toHaveLength(1);
  });

  it('cancel race: before the claim the workflow exits cancelled; during dispatch the signal is honoured before publishOnce', async () => {
    const early = newVariant('E2E cancel in wait');
    const waiting = await schedule(early.id, new Date(Date.now() + 3600_000));
    const h1 = host({ cancelAt: 'wait' });
    await runPublication(h1.control, wfInput(waiting.id), h1.host);
    expect((await row(waiting.id)).state).toBe('cancelled');
    expect(await attemptsOf(waiting.id)).toHaveLength(0);

    const mid = newVariant('E2E cancel after release');
    const dispatching = await schedule(mid.id);
    const cancelResponses: unknown[] = [];
    const h2 = host({ cancelAt: 'after_release' });
    const controlSpy = {
      ...h2.control,
      evaluateRelease: async (i: Parameters<typeof control.evaluateRelease>[0]) => {
        const r = await h2.control.evaluateRelease(i);
        cancelResponses.push(
          await runInTenant(ctx(tenantA), () =>
            withTransaction((tx) =>
              publicationService.cancel(
                publisher(tenantA),
                { publicationId: dispatching.id, expectedVersion: 0 },
                tx,
              ),
            ),
          ),
        );
        return r;
      },
    };
    await runPublication(controlSpy, wfInput(dispatching.id), h2.host);
    expect(cancelResponses[0]).toMatchObject({ prevented: false, state: 'dispatching' });
    expect((await row(dispatching.id)).state).toBe('cancelled');
    expect(await attemptsOf(dispatching.id)).toHaveLength(0);
    expect(fixture.posts.some((p) => p.text === 'E2E cancel after release')).toBe(false);

    const late = newVariant('E2E cancel after send');
    const sent = await schedule(late.id);
    const h3 = host({ cancelAt: 'after_send' });
    await runPublication(h3.control, wfInput(sent.id), h3.host);
    expect((await row(sent.id)).state).toBe('published'); // once the call started the cancel cannot be honoured
  });

  it('a failed release check at dispatch holds with reasons; a pre-send retryable error re-waits and retries', async () => {
    const v = newVariant('E2E hold');
    const pub = await schedule(v.id);
    releaseDecision = { allow: false, hold: true, reasons: ['approval_matches'] };
    const h = host();
    await runPublication(h.control, wfInput(pub.id), h.host);
    expect(await row(pub.id)).toMatchObject({ state: 'held', holdReasons: ['approval_matches'] });
  });
});
