import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Observability from '@oremedia/observability';
import { and, eq, getTableColumns, getTableName } from 'drizzle-orm';
import type { MySqlTable } from 'drizzle-orm/mysql-core';
import {
  defaultPolicyDocument,
  emptyBrandSystemDocument,
  type BrandSystemDocumentV1,
} from '@oremedia/contracts/brand';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { PublicationWorkflowInputV1, PublishProviderActivitiesV1 } from '@oremedia/contracts/publishing';
import type { DeletionWorkflowInputV1 } from '@oremedia/contracts/operations';
import {
  purgeOrder,
  runInTenant,
  tenantScopedTables,
  withTransaction,
  type TenantContext,
  type Tx,
} from '@oremedia/db';
import { auditEvents, deletionRequests, outboxEvents } from '@oremedia/db/schema/operations';
import {
  channelConnections,
  credentialRefs,
  publicationAttempts,
  publications,
} from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  createDeletionActivities,
  createPublishControlActivities,
  createPublishProviderActivities,
} from '@oremedia/activities';
import { brandService } from '@oremedia/module-brand';
import { contentService } from '@oremedia/module-content';
import { MemoryStorageProvider, configureStorage } from '@oremedia/module-assets';
import {
  DEAD_LETTER_ATTEMPTS,
  createOperationsRuntime,
  deletion,
  dispatchBatch,
  oldestUndispatchedAgeMs,
  outboxRouteFor,
  registerOutboxRoute,
  type WorkflowStarter,
} from '@oremedia/module-operations';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  configurePublishingProviders,
  createPublishingRuntime,
  credentialBroker,
  publicationService,
  registerProviderClients,
  registerWorkflowProbe,
} from '@oremedia/module-publishing';
import { evaluateRelease, reviewService } from '@oremedia/module-review';
import { METRIC, count } from '@oremedia/observability';
import { ProviderRegistry } from '@oremedia/providers';
import { runDeletionRequest } from '@oremedia/workflows/deletion-request.workflow.v1';
import { runPublication, type PublicationHost } from '@oremedia/workflows/publication.workflow.v1';
import { CROSS_TENANT_INPUTS } from '../../../tooling/test-fixtures/src/cross-tenant-inputs';
import { callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';
import { composeModules } from './composition';

vi.mock('@oremedia/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof Observability>();
  return { ...actual, count: vi.fn(actual.count) };
});

/**
 * Spec 17.7 runbooks (docs/runbooks, ledger 7.4–7.12) walked step by step through the worker-core composition root
 * against MySQL: the API procedures the runbooks name (in-process tRPC callers with real sessions), the module
 * services, the real publishing runtime with the fixture provider (a loopback platform), the real release
 * evaluator, memory object storage and the real workflow orchestration with a fake Temporal host. What a runbook
 * needs that only a deployed environment has (Railway, Temporal UI, a real provider account) is listed on the
 * runbook's "needs a live environment for:" line. Rollback-workflow-version is packages/workflows/test; recover
 * rendering is apps/worker-render/src/recover-rendering.integration.test.ts.
 */
const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  voice: { ...emptyBrandSystemDocument().voice, summary: 'Plain', tone: ['plain'], prohibitedPhrases: [] },
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
    ],
    typeRoles: [
      { role: 'display', fontAssetId: 'ast_font', weight: 600, minSizePx: 40 },
      { role: 'heading', fontAssetId: 'ast_font', weight: 600, minSizePx: 28 },
      { role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 18 },
      { role: 'label', fontAssetId: 'ast_font', weight: 500, minSizePx: 14 },
      { role: 'caption', fontAssetId: 'ast_font', weight: 400, minSizePx: 12 },
    ],
    spacingScale: [4, 8, 16],
    radii: [0, 4],
    contrastTarget: 'AA',
  },
});

describe('runbook rehearsals (worker-core composition, fixture provider, fake Temporal host)', () => {
  let tdb: TestDatabase;
  let A: SeededTenant;
  let B: SeededTenant;
  let brand = '';
  let killConn = '';
  let owner: ResolvedActor;
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter();
  registry.register(fixture);
  const mem = new MemoryStorageProvider();
  const runtime = createPublishingRuntime();
  const control = createPublishControlActivities(runtime.control);
  const provider = createPublishProviderActivities(runtime.provider);

  const ctx = (): TenantContext => ({
    tenantId: A.tenantId,
    actor: { kind: 'user', id: A.ownerUserId },
    brandIds: 'all',
    correlationId: 'corr_runbooks',
  });
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx(), () => withTransaction(fn));
  const inTenant = <T>(fn: () => Promise<T>) => runInTenant(ctx(), fn);
  const api = (path: string, input: unknown, opts: { correlationId?: string } = {}) =>
    callPath({ bearer: A.ownerToken, tenantId: A.tenantId, ...opts }, path, input);
  const pubRow = async (id: string) =>
    (await tdb.db.select().from(publications).where(eq(publications.id, id)))[0]!;
  const attemptsOf = (id: string) =>
    tdb.db.select().from(publicationAttempts).where(eq(publicationAttempts.publicationId, id));
  const wfInput = (publicationId: string): PublicationWorkflowInputV1 => ({
    tenantId: A.tenantId,
    actor: { kind: 'user', id: A.ownerUserId },
    correlationId: 'corr_runbooks',
    publicationId,
  });
  /** A fake Temporal host: activities run in-process; sleeps are recorded (or abort the run, a lost worker). */
  const host = (
    opts: { publishOverride?: PublishProviderActivitiesV1['publishOnce']; loseWorkerOnSleep?: boolean } = {},
  ): PublicationHost => {
    const wrapped: PublishProviderActivitiesV1 = {
      ...provider,
      publishOnce: opts.publishOverride ?? provider.publishOnce,
    };
    // A virtual clock: waiting for the scheduled minute advances it instead of blocking the test.
    let skew = 0;
    const advance = (ms: number | string) => {
      skew += typeof ms === 'number' ? ms : 60_000;
    };
    return {
      workflowId: 'pub:runbook',
      runId: '11111111-2222-3333-4444-777777777777',
      cancelRequested: () => false,
      takeRescheduled: () => false,
      now: () => Date.now() + skew,
      waitForSignal: async (ms) => advance(ms),
      sleep: async (ms) => {
        if (opts.loseWorkerOnSleep) throw new Error('worker lost');
        advance(ms);
      },
      providerActivities: () => ({ publish: wrapped, lookup: wrapped }),
    };
  };

  let multiChannel: string[] = [];

  async function connect(remoteAccountId: string): Promise<string> {
    fixture.grant = { ...fixture.grant, remoteAccountId, displayName: remoteAccountId };
    const started = await run((tx) =>
      channelService.connect.start(
        owner,
        { brandId: brand, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    return (
      await run((tx) => channelService.connect.complete(owner, { state: started.state, code: 'good' }, tx))
    ).id;
  }

  /** A package reviewed and approved for its channels, one scheduled publication per channel (spec 13, 14.1). */
  async function scheduled(title: string, connectionIds: string[]) {
    const at = new Date(Date.now() + 60_000);
    const pkg = await run((tx) =>
      contentService.packages.create(
        owner,
        {
          brandId: brand,
          title,
          copy: { schemaVersion: 1, master: { text: `${title} caption`, factRefs: [] } },
          creativeDocumentIds: [],
        },
        tx,
      ),
    );
    const gen = await run((tx) =>
      contentService.variants.generate(
        owner,
        { contentRevisionId: pkg.contentRevisionId, channelConnectionIds: connectionIds },
        tx,
      ),
    );
    const req = await run((tx) =>
      reviewService.requests.create(
        owner,
        {
          contentRevisionId: pkg.contentRevisionId,
          assigneeUserIds: [],
          timing: { kind: 'exact', at: at.toISOString() },
        },
        tx,
      ),
    );
    const decided = await run((tx) =>
      reviewService.decisions.submit(
        owner,
        { reviewRequestId: req.reviewRequestId, decision: 'approve', expectedManifestHash: req.manifestHash },
        tx,
      ),
    );
    const ids: string[] = [];
    for (const variantId of gen.created) {
      const pub = await run((tx) =>
        publicationService.schedule(
          owner,
          {
            channelVariantId: variantId,
            scheduledFor: at.toISOString(),
            authority: 'approval',
            approvalId: decided.approvalId!,
          },
          tx,
        ),
      );
      ids.push(pub.id);
    }
    return { ids, at, approvalId: decided.approvalId! };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ({ tenantA: A, tenantB: B } = await seedTwoTenants(tdb.db));
    brand = A.brandIds[1]; // the seed leaves brand 2 without content; the rehearsals build theirs there
    owner = {
      kind: 'user',
      id: A.ownerUserId,
      tenantId: A.tenantId,
      membershipId: A.ownerMembershipId,
      membershipStatus: 'active',
      role: 'owner',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    // The worker's composition root; only the seams a test controls are re-registered afterwards.
    composeModules();
    configurePublishingProviders({ registry, insecureAllowLoopback: true });
    configureCredentialBroker({ kms: new LocalKms('runbook-rehearsal-master-secret-0123456789') });
    registerProviderClients(() => ({ clientId: 'c', clientSecret: 's' }));
    registerWorkflowProbe(null);
    configureStorage(mem);
    const draft = await run((tx) => brandService.versions.createDraft(owner, { brandId: brand }, tx));
    await run((tx) =>
      brandService.versions.update(
        owner,
        { brandId: brand, versionId: draft.versionId, expectedVersion: 0, document: brandDocument() },
        tx,
      ),
    );
    await run((tx) =>
      brandService.versions.submitForReview(
        owner,
        { brandId: brand, versionId: draft.versionId, expectedVersion: 1 },
        tx,
      ),
    );
    await run((tx) =>
      brandService.versions.publish(
        owner,
        { brandId: brand, versionId: draft.versionId, expectedVersion: 2 },
        tx,
      ),
    );
    const pv = await run((tx) =>
      brandService.policy.createVersion(owner, { brandId: brand, document: defaultPolicyDocument() }, tx),
    );
    await run((tx) =>
      brandService.policy.activate(
        owner,
        { brandId: brand, policyVersionId: pv.policyVersionId, expectedVersion: 0 },
        tx,
      ),
    );
  });
  afterAll(async () => {
    await tdb?.drop();
  });
  beforeEach(() => {
    fixture.behaviour = { kind: 'accept' };
    fixture.reconcileBehaviour = 'scan';
    fixture.refreshBehaviour = {
      ok: true,
      credentials: { accessToken: 'at_refreshed', refreshToken: 'rt_2' },
    };
  });

  it('reconnect a channel (7.4): reconnect_needed holds dispatch; the same account reconnects, the credential rotates, the held post re-releases and publishes', async () => {
    const conn = await connect('acct_reconnect');
    const { ids } = await scheduled('Reconnect', [conn]);
    const pubId = ids[0]!;
    // Symptom: the refresh workflow's activity reports reconnect_required.
    fixture.refreshBehaviour = { ok: false, reason: 'reconnect_required' };
    const refresh = await inTenant(() =>
      createPublishingRuntime().tokenRefresh.refreshCredentials({
        tenantId: A.tenantId,
        actor: { kind: 'user', id: A.ownerUserId },
        correlationId: 'corr_runbooks',
        channelConnectionId: conn,
      }),
    );
    expect(refresh).toEqual({ ok: false, reason: 'reconnect_required' });
    expect(vi.mocked(count)).toHaveBeenCalledWith(METRIC.reconnectNeeded, 1, {
      providerKey: FIXTURE_PROVIDER_KEY,
    });
    // Step 1: confirm the state through the API the runbook names.
    const listed = await api('publishing.channels.list', { brandId: brand });
    const view = (listed.data as Array<{ id: string; status: string; usable: boolean }>).find(
      (c) => c.id === conn,
    )!;
    expect(view).toMatchObject({ status: 'reconnect_needed', usable: false });
    // The due publication is held at dispatch with channel_active, never sent.
    await runPublication(control, wfInput(pubId), host());
    expect(await pubRow(pubId)).toMatchObject({ state: 'held' });
    expect((await pubRow(pubId)).holdReasons).toContain('channel_active');
    expect(await attemptsOf(pubId)).toHaveLength(0);
    // Step 3: reconnect the same remote account: same connection, new credential, old one shredded.
    const before = (
      await tdb.db.select().from(channelConnections).where(eq(channelConnections.id, conn))
    )[0]!;
    fixture.refreshBehaviour = {
      ok: true,
      credentials: { accessToken: 'at_refreshed', refreshToken: 'rt_2' },
    };
    expect(await connect('acct_reconnect')).toBe(conn);
    const after = (await tdb.db.select().from(channelConnections).where(eq(channelConnections.id, conn)))[0]!;
    expect(after.status).toBe('active');
    expect(after.credentialRefId).not.toBe(before.credentialRefId);
    const old = (
      await tdb.db.select().from(credentialRefs).where(eq(credentialRefs.id, before.credentialRefId))
    )[0]!;
    expect(old.destroyedAt).not.toBeNull();
    expect(old.ciphertext).toBe('');
    // Step 5: re-release the held publication through the API; step 6: it publishes.
    const held = await pubRow(pubId);
    const res = await api('publishing.publications.reschedule', {
      publicationId: pubId,
      expectedVersion: held.version,
      scheduledFor: held.scheduledFor.toISOString(),
    });
    expect(res.error).toBeUndefined();
    expect((await pubRow(pubId)).state).toBe('scheduled');
    await runPublication(control, wfInput(pubId), host());
    expect(await pubRow(pubId)).toMatchObject({ state: 'published' });
    expect(vi.mocked(count)).toHaveBeenCalledWith(METRIC.publicationOutcomes, 1, { outcome: 'published' });
  });

  it('reconcile outcome_unknown (7.5): never re-sent; a human confirms the post found remotely; an unresolved held row is closed, not confirmed', async () => {
    const conn = await connect('acct_reconcile');
    const { ids } = await scheduled('Reconcile', [conn]);
    const [lostWorker, exhausted] = [ids[0]!, (await scheduled('Reconcile 2', [conn])).ids[0]!];
    const crashAfterSend: PublishProviderActivitiesV1['publishOnce'] = async (i) => {
      await provider.publishOnce(i).catch(() => undefined); // the post lands; the response is lost
      throw new Error('activity heartbeat timeout');
    };
    // (a) The worker is lost during reconciliation: the row stays outcome_unknown.
    fixture.behaviour = { kind: 'crash_after_send' };
    fixture.reconcileBehaviour = 'cannot_determine';
    const postsBefore = fixture.posts.length;
    await runPublication(
      control,
      wfInput(lostWorker),
      host({ publishOverride: crashAfterSend, loseWorkerOnSleep: true }),
    ).catch(() => undefined);
    expect((await pubRow(lostWorker)).state).toBe('outcome_unknown');
    expect(vi.mocked(count)).toHaveBeenCalledWith(METRIC.publicationOutcomes, 1, {
      outcome: 'outcome_unknown',
    });
    // Step 1: the API shows the attempt with sentAt: the platform may have the post (step 3), so no re-send.
    const got = (await api('publishing.publications.get', { publicationId: lostWorker })).data as {
      attempts: Array<{ sentAt: string | null }>;
    };
    expect(got.attempts).toHaveLength(1);
    expect(got.attempts[0]!.sentAt).not.toBeNull();
    // Step 3/4: the post is on the remote account; the human confirms it.
    const remote = fixture.posts.at(-1)!;
    expect(fixture.posts.length).toBe(postsBefore + 1);
    const confirmed = await api('publishing.publications.reconcile', {
      publicationId: lostWorker,
      resolution: 'confirm_published',
      remotePostId: remote.id,
      remoteUrl: `https://fixture.example/p/${remote.id}`,
    });
    expect(confirmed.error).toBeUndefined();
    expect(await pubRow(lostWorker)).toMatchObject({ state: 'published', remotePostId: remote.id });
    const evidence = (await api('publishing.publications.evidence', { publicationId: lostWorker }))
      .data as Array<{
      kind: string;
    }>;
    expect(evidence.map((e) => e.kind)).toContain('human_confirmation');

    // (b) Reconciliation exhausted (cannot determine at +1m, +5m, +15m, +1h) → held for a human.
    await runPublication(control, wfInput(exhausted), host({ publishOverride: crashAfterSend }));
    const heldRow = await pubRow(exhausted);
    expect(heldRow.state).toBe('held');
    // A held row cannot be confirmed as published (machine: no held → published); the team closes it.
    const refused = await api('publishing.publications.reconcile', {
      publicationId: exhausted,
      resolution: 'confirm_published',
      remotePostId: fixture.posts.at(-1)!.id,
    });
    expect(refused.error?.code).toBe('VALIDATION_FAILED');
    const closed = await api('publishing.publications.reconcile', {
      publicationId: exhausted,
      resolution: 'cancel',
    });
    expect(closed.error).toBeUndefined();
    expect((await pubRow(exhausted)).state).toBe('cancelled');
    // Step 7: one attempt per publication, one remote post per publication, nothing sent twice.
    expect(await attemptsOf(lostWorker)).toHaveLength(1);
    expect(await attemptsOf(exhausted)).toHaveLength(1);
    expect(fixture.posts.length).toBe(postsBefore + 2);
  });

  it('drain and replay the outbox (7.6): a failing start dead-letters after 5 attempts, the tenant lists and replays it through the API, the replay dispatches once', async () => {
    const eventType = 'measurement.collection_due'; // any routed event; the route is replaced for the rehearsal
    let healthy = false;
    const starts: string[] = [];
    const original = outboxRouteFor(eventType);
    registerOutboxRoute(eventType, (evt) => ({
      workflowType: 'metricCollectionWorkflowV1',
      taskQueue: 'ingest-metrics',
      workflowId: `metrics:${evt.aggregateId}`,
      args: [],
    }));
    const starter: WorkflowStarter = {
      start: async (req) => {
        if (!healthy && req.workflowId === 'metrics:pub_runbook_dead')
          throw new Error('temporal: namespace not found');
        starts.push(req.workflowId);
      },
    };
    const deadId = 'obx_RUNBOOKDEADLETTER00000000';
    await tdb.db.insert(outboxEvents).values({
      id: deadId,
      tenantId: A.tenantId,
      aggregateType: 'publication',
      aggregateId: 'pub_runbook_dead',
      aggregateVersion: 1,
      eventType,
      schemaVersion: 1,
      payload: {},
      correlationId: 'corr_runbooks',
      availableAt: new Date(),
    });
    let clock = Date.now();
    for (let i = 0; i < DEAD_LETTER_ATTEMPTS; i++) {
      await dispatchBatch({ workerId: 'w-runbook', starter, now: () => new Date(clock) });
      clock += 16 * 60_000; // past the capped backoff
    }
    const row = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.id, deadId)))[0]!;
    expect(row).toMatchObject({ attempts: DEAD_LETTER_ATTEMPTS, dispatchedAt: null });
    expect(row.lastError).toContain('namespace not found');
    // Symptom: the oldest-undispatched gauge is above 60 s.
    expect((await oldestUndispatchedAgeMs(new Date(clock))) ?? 0).toBeGreaterThan(60_000);
    // Step 3: the tenant's dead letters (another tenant's are not visible).
    const dead = (await api('operations.outbox.deadLetters', undefined)).data as Array<{
      id: string;
      tenantId: string;
    }>;
    expect(dead.map((d) => d.id)).toContain(deadId);
    expect(dead.every((d) => d.tenantId === A.tenantId)).toBe(true);
    const foreign = await callPath(
      { bearer: B.ownerToken, tenantId: B.tenantId },
      'operations.outbox.replay',
      { eventId: deadId },
    );
    expect(foreign.error?.code).toBe('NOT_FOUND');
    // Step 2 fixed (Temporal reachable again); step 4 replay: claimable now, error cleared, attempts kept.
    healthy = true;
    expect((await api('operations.outbox.replay', { eventId: deadId })).error).toBeUndefined();
    const replayed = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.id, deadId)))[0]!;
    expect(replayed).toMatchObject({ lastError: null, attempts: DEAD_LETTER_ATTEMPTS });
    await dispatchBatch({ workerId: 'w-runbook', starter });
    expect(starts.filter((s) => s === 'metrics:pub_runbook_dead')).toHaveLength(1);
    // Step 6: drained; the replay is audited.
    const after = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.id, deadId)))[0]!;
    expect(after.dispatchedAt).not.toBeNull();
    const again = (await api('operations.outbox.deadLetters', undefined)).data as Array<{ id: string }>;
    expect(again.map((d) => d.id)).not.toContain(deadId);
    const audit = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'operations.outbox.replay'), eq(auditEvents.resourceId, deadId)));
    expect(audit).toHaveLength(1);
    if (original) registerOutboxRoute(eventType, original); // the real route again
  });

  it('kill switch (7.7): release_dispatch holds the mandate path with kill_switch_off; agent_starts refuses new runs; release is audited and nothing auto-releases', async () => {
    const conn = await connect('acct_kill');
    killConn = conn;
    const { ids } = await scheduled('Kill switch', [conn]);
    const row = await pubRow(ids[0]!);
    const mandatePath = {
      id: row.id,
      tenantId: row.tenantId,
      brandId: row.brandId,
      contentPackageId: row.contentPackageId,
      contentRevisionId: row.contentRevisionId,
      channelVariantId: row.channelVariantId,
      channelConnectionId: row.channelConnectionId,
      authority: 'mandate' as const,
      approvalId: null,
      mandateId: null,
      scheduledFor: row.scheduledFor.toISOString(),
      state: 'scheduled' as const,
    };
    const reasonsNow = async () => {
      const d = await inTenant(() => evaluateRelease(mandatePath, new Date()));
      return d.allow ? [] : d.reasons;
    };
    expect(await reasonsNow()).not.toContain('kill_switch_off');
    // Step 1: engage for the brand through the API, with a reason.
    const engaged = await api('operations.killSwitch.set', {
      scope: 'release_dispatch',
      brandId: brand,
      engaged: true,
      reason: 'runaway autopublish (rehearsal)',
    });
    expect(engaged.error).toBeUndefined();
    expect(await reasonsNow()).toContain('kill_switch_off');
    expect(
      (
        (await api('operations.killSwitch.get', { scope: 'release_dispatch', brandId: brand })).data as {
          engaged: boolean;
        }
      ).engaged,
    ).toBe(true);
    // The switch is scoped to autonomous (mandate) publication, as spec 13.4 states it: an approval-path post is
    // not stopped by it. The runbook says so and names the containment for approval-path posts (gap reported).
    await runPublication(control, wfInput(row.id), host());
    expect((await pubRow(row.id)).state).toBe('published');
    // Step 2: agent_starts refuses new runs for the brand.
    await api('operations.killSwitch.set', {
      scope: 'agent_starts',
      brandId: brand,
      engaged: true,
      reason: 'rehearsal',
    });
    const agent = (
      await api('access.servicePrincipals.create', {
        kind: 'agent',
        name: 'rehearsal copywriter',
        grants: [{ action: 'agent.start_run', brandIds: 'all' }],
        maxAutonomy: 'create',
      })
    ).data as { servicePrincipalId: string };
    const startRun = () =>
      api('agents.runs.start', {
        brandId: brand,
        servicePrincipalId: agent.servicePrincipalId,
        requestedAutonomy: 'create',
        taskKind: 'copywriting',
        brief: { objective: 'x' },
      });
    const refused = await startRun();
    expect(refused.error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Agent starts are paused for this brand',
    });
    // Step 4: release both; step 5: the audit trail holds engage/release pairs with the reasons.
    await api('operations.killSwitch.set', {
      scope: 'release_dispatch',
      brandId: brand,
      engaged: false,
      reason: 'resolved',
    });
    await api('operations.killSwitch.set', {
      scope: 'agent_starts',
      brandId: brand,
      engaged: false,
      reason: 'resolved',
    });
    expect(await reasonsNow()).not.toContain('kill_switch_off');
    // Released: the start is no longer refused by the switch (it may still fail later checks, e.g. budget).
    expect((await startRun()).error?.message).not.toBe('Agent starts are paused for this brand');
    const trail = (
      await api('operations.audit.query', { query: { resourceType: 'kill_switch' }, page: { limit: 50 } })
    ).data as { items: Array<{ action: string }> };
    const actions = trail.items.map((i) => i.action);
    expect(actions.filter((a) => a === 'kill_switch.engage').length).toBeGreaterThanOrEqual(2);
    expect(actions.filter((a) => a === 'kill_switch.release').length).toBeGreaterThanOrEqual(2);
  });

  it('partial multi-channel success (7.8): each channel is its own row; the failed one is final, the held one re-releases alone, the published one is never touched', async () => {
    const ok = await connect('acct_multi_ok');
    const bad = await connect('acct_multi_bad');
    const later = await connect('acct_multi_held');
    multiChannel = [ok, later];
    // One approved package per channel here: see the known defect below for one package on several channels.
    const [pOk, pBad, pHeld] = [
      (await scheduled('Multi ok', [ok])).ids[0]!,
      (await scheduled('Multi bad', [bad])).ids[0]!,
      (await scheduled('Multi held', [later])).ids[0]!,
    ];
    await runPublication(control, wfInput(pOk), host());
    fixture.behaviour = { kind: 'reject', code: 'media_dimensions' };
    await runPublication(control, wfInput(pBad), host());
    fixture.behaviour = { kind: 'accept' };
    // The third channel's connection is revoked before its dispatch: held with channel_active.
    const c3 = (await tdb.db.select().from(channelConnections).where(eq(channelConnections.id, later)))[0]!;
    await run((tx) =>
      channelService.disconnect(owner, { channelConnectionId: later, expectedVersion: c3.version }, tx),
    );
    expect((await pubRow(pHeld)).state).toBe('held');
    const published = await pubRow(pOk);
    // Step 1 and 2: list by state and read each reason.
    const failed = (
      await api('publishing.publications.list', { brandId: brand, state: 'failed', page: { limit: 50 } })
    ).data as { items: Array<{ id: string; state: string }> };
    expect(failed.items.map((p) => p.id)).toContain(pBad);
    const detail = (await api('publishing.publications.get', { publicationId: pBad })).data as {
      state: string;
      stateReason: string | null;
    };
    expect(detail).toMatchObject({ state: 'failed', stateReason: 'media_dimensions' });
    expect(published.state).toBe('published');
    // A failed row is final: it cannot be re-released; the fix is a new revision and a fresh approval (step 3).
    const refused = await api('publishing.publications.reschedule', {
      publicationId: pBad,
      expectedVersion: (await pubRow(pBad)).version,
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(refused.error?.code).toBe('VALIDATION_FAILED');
    // Step 4: reconnect and re-release only the held channel.
    expect(await connect('acct_multi_held')).toBe(later);
    const held = await pubRow(pHeld);
    expect(
      (
        await api('publishing.publications.reschedule', {
          publicationId: pHeld,
          expectedVersion: held.version,
          scheduledFor: held.scheduledFor.toISOString(),
        })
      ).error,
    ).toBeUndefined();
    await runPublication(control, wfInput(pHeld), host());
    expect((await pubRow(pHeld)).state).toBe('published');
    // A second schedule of the published channel's occurrence is a CONFLICT, never a second post.
    const variantOk = published.channelVariantId;
    const dup = await api('publishing.publications.schedule', {
      channelVariantId: variantOk,
      scheduledFor: published.scheduledFor.toISOString(),
      authority: 'approval',
      approvalId: published.approvalId,
    });
    expect(dup.error).toBeDefined();
    // Step 5: the published row did not move.
    expect(await pubRow(pOk)).toMatchObject({ state: 'published', version: published.version });
    expect(vi.mocked(count)).toHaveBeenCalledWith(METRIC.publicationOutcomes, 1, { outcome: 'failed' });
  });

  // Spec 13.2: one approval binds every channel target of the revision, so it is spent only once every target has
  // published; the first channel's publication must never hold the second at approval_valid.
  it('partial multi-channel success (7.8): the second channel of one approved package publishes after the first', async () => {
    // Reuses two active connections from the previous rehearsal: the pilot plan allows ten channels per tenant
    // and this file connects several before this point.
    const [one, two] = multiChannel;
    if (!one || !two) throw new Error('the previous rehearsal must have connected two channels');
    const { ids } = await scheduled('One package, two channels', [one, two]);
    await runPublication(control, wfInput(ids[0]!), host());
    await runPublication(control, wfInput(ids[1]!), host());
    expect((await pubRow(ids[0]!)).state).toBe('published');
    expect(await pubRow(ids[1]!)).toMatchObject({ state: 'published' });
  });

  it('revoke a compromised credential (7.10): API key rotation and principal revocation, social token crypto-shred with holds, session revocation on role change', async () => {
    // API client key.
    const created = (
      await api('access.apiClients.create', { servicePrincipalId: A.servicePrincipalId, scopes: [] })
    ).data as { apiClientId: string; key: string };
    expect((await callPath({ bearer: created.key }, 'brand.list', undefined)).error).toBeUndefined();
    const rotated = (await api('access.apiClients.rotate', { apiClientId: created.apiClientId })).data as {
      key: string;
    };
    expect((await callPath({ bearer: created.key }, 'brand.list', undefined)).error?.code).toBe(
      'UNAUTHENTICATED',
    );
    expect((await callPath({ bearer: rotated.key }, 'brand.list', undefined)).error).toBeUndefined();
    // All keys of a principal: revoke the principal.
    const sp = (
      await api('access.servicePrincipals.create', {
        kind: 'agent',
        name: 'compromised agent',
        grants: [{ action: 'brand.read', brandIds: 'all' }],
        maxAutonomy: 'assist',
      })
    ).data as { servicePrincipalId: string };
    const k = (
      await api('access.apiClients.create', { servicePrincipalId: sp.servicePrincipalId, scopes: [] })
    ).data as {
      key: string;
    };
    expect((await callPath({ bearer: k.key }, 'brand.list', undefined)).error).toBeUndefined();
    expect(
      (
        await api('access.servicePrincipals.revoke', {
          servicePrincipalId: sp.servicePrincipalId,
          expectedVersion: 0,
        })
      ).error,
    ).toBeUndefined();
    expect((await callPath({ bearer: k.key }, 'brand.list', undefined)).error?.code).toBe('UNAUTHENTICATED');
    // Social token: disconnect shreds the credential in the same transaction and holds the scheduled posts.
    // The kill-switch rehearsal's connection (the tenant's channel entitlement is finite): now compromised.
    const conn = killConn;
    const { ids } = await scheduled('Compromised', [conn]);
    const c = (await tdb.db.select().from(channelConnections).where(eq(channelConnections.id, conn)))[0]!;
    const res = await api('publishing.channels.disconnect', {
      channelConnectionId: conn,
      expectedVersion: c.version,
    });
    expect(res.error).toBeUndefined();
    const cred = (
      await tdb.db.select().from(credentialRefs).where(eq(credentialRefs.id, c.credentialRefId))
    )[0]!;
    expect(cred).toMatchObject({ ciphertext: '', wrappedDataKey: '' });
    expect(cred.destroyedAt).not.toBeNull();
    expect(await pubRow(ids[0]!)).toMatchObject({ state: 'held' });
    await expect(
      inTenant(() => credentialBroker.withCredentials(A.tenantId, conn, async () => 'x')),
    ).rejects.toMatchObject({ reason: 'credential_destroyed' });
    // Session: a role change revokes the member's sessions (spec 18); the next request is refused.
    expect(
      (await callPath({ bearer: A.creatorToken, tenantId: A.tenantId }, 'brand.list', undefined)).error,
    ).toBeUndefined();
    const setRole = await api('access.members.setRole', {
      membershipId: A.creatorMembershipId,
      expectedVersion: 0,
      role: 'reviewer',
    });
    expect(setRole.error).toBeUndefined();
    expect(
      (await callPath({ bearer: A.creatorToken, tenantId: A.tenantId }, 'brand.list', undefined)).error?.code,
    ).toBe('UNAUTHENTICATED');
  });

  it('suspected cross-tenant exposure (7.12): contain with tenant-wide switches, preserve the audit evidence by correlation id, re-run every harness fixture against this build', async () => {
    const incident = `incident-${Date.now()}`;
    // Step 1: contain.
    for (const scope of ['release_dispatch', 'agent_starts'])
      expect(
        (
          await api(
            'operations.killSwitch.set',
            { scope, brandId: null, engaged: true, reason: 'sev1 suspected exposure' },
            {
              correlationId: incident,
            },
          )
        ).error,
      ).toBeUndefined();
    // Step 2: preserve evidence: the audit trail carries the actor, the reason and the incident's correlation id.
    const trail = (
      await api('operations.audit.query', { query: { resourceType: 'kill_switch' }, page: { limit: 50 } })
    ).data as { items: Array<{ action: string; correlationId: string; actorId: string }> };
    const ours = trail.items.filter((i) => i.correlationId === incident);
    expect(ours).toHaveLength(2);
    expect(ours.every((i) => i.action === 'kill_switch.engage' && i.actorId === A.ownerUserId)).toBe(true);
    // Step 3: determine scope: every procedure's cross-tenant fixture, as tenant B's owner against tenant A's ids.
    const before = await A.snapshot();
    const leaks: string[] = [];
    // The harness keeps one fixture per procedure (a procedure without one fails CI), so its keys are the router.
    for (const [path, fixtureFor] of Object.entries(CROSS_TENANT_INPUTS)) {
      if (!fixtureFor?.buildInput) continue;
      const res = await callPath(
        { bearer: B.ownerToken, tenantId: B.tenantId },
        path,
        fixtureFor.buildInput(A.ids),
      );
      if (fixtureFor.expectEmpty && !res.error) {
        const data = res.data as { items?: unknown[] } | unknown[] | null;
        const items = Array.isArray(data) ? data : (data?.items ?? []);
        if (items.length) leaks.push(path);
      } else if (
        !res.error ||
        ![fixtureFor.expectCode ?? 'NOT_FOUND', 'VALIDATION_FAILED'].includes(res.error.code)
      )
        leaks.push(`${path}:${res.error?.code ?? 'data'}`);
    }
    expect(leaks).toEqual([]);
    expect(await A.snapshot()).toBe(before); // nothing landed in the tenant under investigation
    for (const scope of ['release_dispatch', 'agent_starts'])
      await api('operations.killSwitch.set', {
        scope,
        brandId: null,
        engaged: false,
        reason: 'no exposure found',
      });
  });
  it("restore a single tenant (7.11): the tenant's rows are re-imported from a restore point, the other tenant is untouched, deletions requested after the restore point are re-applied", async () => {
    const tables = tenantScopedTables();
    const snapshotB = await B.snapshot();
    // Step 1–2: the restore point: a tenant-scoped dump of every tenant table (what the PITR copy holds).
    const dump = new Map<MySqlTable, Record<string, unknown>[]>();
    for (const t of tables) {
      const tenantCol = Object.values(getTableColumns(t)).find((c) => c.name === 'tenant_id')!;
      dump.set(
        t,
        (await tdb.db.select().from(t).where(eq(tenantCol, A.tenantId))) as Record<string, unknown>[],
      );
    }
    // After the restore point: the tenant deletes brand 1 (a completed deletion request) …
    const requested = await api('operations.deletion.request', {
      subjectType: 'brand',
      subjectId: A.brandIds[0],
      reason: 'brand retired',
    });
    const deletionRequestId = (requested.data as { deletionRequestId: string }).deletionRequestId;
    const deletionActs = createDeletionActivities(createOperationsRuntime().deletion);
    const input: DeletionWorkflowInputV1 = {
      tenantId: A.tenantId,
      actor: { kind: 'user', id: A.ownerUserId },
      correlationId: 'corr_runbooks',
      deletionRequestId,
    };
    await runDeletionRequest(deletionActs, input);
    const brand1Rows = async () =>
      (await tdb.db.select().from(publications).where(eq(publications.brandId, A.brandIds[0]))).length;
    expect(await brand1Rows()).toBe(0);
    // … and an accident removes brand 2's publications (the corruption the restore repairs).
    const accidentIds = (await tdb.db.select().from(publications).where(eq(publications.brandId, brand))).map(
      (p) => p.id,
    );
    expect(accidentIds.length).toBeGreaterThan(0);
    await tdb.db.delete(publicationAttempts).where(eq(publicationAttempts.tenantId, A.tenantId));
    await tdb.db.delete(publications).where(eq(publications.brandId, brand));
    // Step 4: kill switches first (both scopes, tenant-wide).
    await api('operations.killSwitch.set', {
      scope: 'release_dispatch',
      brandId: null,
      engaged: true,
      reason: 'restore',
    });
    await api('operations.killSwitch.set', {
      scope: 'agent_starts',
      brandId: null,
      engaged: true,
      reason: 'restore',
    });
    // Step 4: import the tenant's rows, parents first, only rows missing in production (tenant-scoped).
    let imported = 0;
    for (const t of [...purgeOrder(tables)].reverse()) {
      const rows = dump.get(t) ?? [];
      if (rows.length === 0 || getTableName(t) === 'deletion_requests' || getTableName(t) === 'audit_events')
        continue;
      const res = await tdb.db
        .insert(t)
        .ignore()
        .values(rows as never);
      imported += (res as unknown as [{ affectedRows: number }])[0].affectedRows;
    }
    expect(imported).toBeGreaterThan(0);
    const restored = await tdb.db.select().from(publications).where(eq(publications.brandId, brand));
    expect(restored.map((p) => p.id).sort()).toEqual(accidentIds.sort());
    // Step 5 (the restore rule): the restored in-flight publications are the reconcile list. Moving them to held
    // needs a publishing command that does not exist yet (reported); the kill switch covers the mandate path only.
    const inFlight = restored.filter((p) => ['scheduled', 'dispatching', 'processing'].includes(p.state));
    expect(inFlight.every((p) => p.tenantId === A.tenantId)).toBe(true);
    // Step 6: deletions requested after the restore point are re-applied before release.
    expect(await brand1Rows()).toBeGreaterThan(0); // the dump brought brand 1 back
    const after = (
      await tdb.db.select().from(deletionRequests).where(eq(deletionRequests.tenantId, A.tenantId))
    ).filter(
      (d) => !(dump.get(deletionRequests as unknown as MySqlTable) ?? []).some((r) => r['id'] === d.id),
    );
    expect(after.map((d) => d.id)).toEqual([deletionRequestId]);
    for (const d of after) {
      await run((tx) => deletion.reapply({ kind: 'platform_operator', id: 'oncall' }, d.id, tx));
      await runDeletionRequest(deletionActs, { ...input, deletionRequestId: d.id });
    }
    expect(await brand1Rows()).toBe(0);
    // Step 7: the other tenant is untouched; release the kill switches.
    expect(await B.snapshot()).toBe(snapshotB);
    await api('operations.killSwitch.set', {
      scope: 'release_dispatch',
      brandId: null,
      engaged: false,
      reason: 'restored',
    });
    await api('operations.killSwitch.set', {
      scope: 'agent_starts',
      brandId: null,
      engaged: false,
      reason: 'restored',
    });
  });
});
