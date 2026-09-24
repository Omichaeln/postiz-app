import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ConflictError, NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { MembershipRole } from '@oremedia/contracts/tenancy';
import type { CommentPage, DecryptedCredentials, RawMetricPoint } from '@oremedia/contracts/providers';
import { requireTenant, runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { tenants } from '@oremedia/db/schema/access';
import { brandObjectives, brands } from '@oremedia/db/schema/brand';
import { messages } from '@oremedia/db/schema/community';
import { creativeAttributes } from '@oremedia/db/schema/content';
import { creativeDocuments, creativeRevisions } from '@oremedia/db/schema/creative';
import {
  linkClicks,
  metricDefinitions,
  metricSnapshots,
  trackedLinks,
} from '@oremedia/db/schema/measurement';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { publications, remoteEvidence } from '@oremedia/db/schema/publishing';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { outboxRouteFor } from '@oremedia/module-operations';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  configurePublishingProviders,
  fixtureCapability,
  registerProviderClients,
  registerPublishingBrandChecker,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';
import { attributeService } from './attributes';
import { createCommentIngestionRuntime, authorHash } from './comments';
import { createMetricCollectionRuntime } from './collection';
import { definitionService } from './definitions';
import {
  configureAuthorHashing,
  configureLinkTracking,
  registerBrandChecker,
  registerCommentSink,
  resetCommentSinks,
  type IngestedComment,
} from './hooks';
import { SHORT_CODE_PATTERN, linkService } from './links';
import { createMetricService } from './metrics';
import { registerMeasurementOutboxRoutes } from './outbox-routes';

/**
 * The measurement module against MySQL 8 (spec 15, 16.2, 16.5): global definitions seeded from the capability
 * register and tenant definitions; raw snapshots with provenance where unavailable is a null row (never zero) and
 * a pull is idempotent per (publication, metric, window); derived rates with operand ids; the query with freshness,
 * stale marking and coverage; the quality composite with brand weights; tracked links agreeing with the
 * redirector's resolver; creative attributes captured and corrected; comment ingestion with salted author hashes
 * and the sink; the outbox route. Cross-tenant: every foreign id is NOT_FOUND.
 */
const USER = 'usr_measurement_test';
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_measurement',
});
const analyst = (tenantId: string, role: MembershipRole = 'analyst'): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_measurement_test',
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(ctx(tenantId), () => withTransaction(fn));
const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runInTenant(ctx(tenantId), fn);

const T0 = new Date('2026-09-24T10:00:00.000Z');
const HOUR = 3_600_000;

/** The fixture platform with a measurement surface: scripted metric points and comment pages. */
class MeasuringFixture extends FixtureProviderAdapter {
  metricsBehaviour: 'ok' | 'partial' | 'fail' | 'missing_scope' = 'ok';
  commentPages: CommentPage[] = [];
  readonly metricCalls: Array<{ remotePostId: string; window: { start: string; end: string } }> = [];
  async fetchPostMetrics(
    req: { remotePostId: string; window: { start: string; end: string } },
    _creds: DecryptedCredentials,
  ): Promise<RawMetricPoint[]> {
    this.metricCalls.push(req);
    if (this.metricsBehaviour === 'fail') throw new Error('platform 500');
    const w = { windowStart: req.window.start, windowEnd: req.window.end };
    if (this.metricsBehaviour === 'missing_scope')
      return this.capability.analytics.post.map((n) => ({
        nativeName: n,
        value: null,
        completeness: 'unavailable',
        ...w,
      }));
    return [
      { nativeName: 'impressionCount', value: 1000, completeness: 'complete', ...w },
      {
        nativeName: 'engagement',
        value: 50,
        completeness: this.metricsBehaviour === 'partial' ? 'partial' : 'complete',
        ...w,
      },
      { nativeName: 'saveCount', value: 8, completeness: 'complete', ...w },
      { nativeName: 'shareCount', value: 4, completeness: 'complete', ...w },
      { nativeName: 'clickCount', value: null, completeness: 'unavailable', ...w },
      {
        nativeName: 'audienceRetention',
        value: null,
        completeness: 'complete',
        series: [
          { at: '0', value: 1 },
          { at: '5', value: 0.4 },
        ],
        ...w,
      },
    ];
  }
  async fetchComments(req: { cursor?: string }): Promise<CommentPage> {
    const page = Number(req.cursor ?? '0');
    return this.commentPages[page] ?? { items: [] };
  }
}

describe('measurement module (spec 15, 16.2, 16.5) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const A = analyst(tenantA);
  const B = analyst(tenantB);
  const registry = new ProviderRegistry();
  const fixture = new MeasuringFixture(
    fixtureCapability({
      analytics: {
        post: ['impressionCount', 'engagement', 'saveCount', 'shareCount', 'clickCount', 'audienceRetention'],
        account: ['followerCount'],
        latencyHours: 2,
      },
      comments: { read: true, reply: false },
    }),
  );
  registry.register(fixture);
  let now = T0;
  const collection = createMetricCollectionRuntime({ now: () => now });
  const ingestion = createCommentIngestionRuntime();
  const metrics = createMetricService({ now: () => now });
  let connA = '';
  let connB = '';
  let pubA = '';
  let pubB = '';
  const sinkCalls: IngestedComment[][] = [];

  const wfInput = (publicationId: string, tenantId = tenantA) => ({
    tenantId,
    actor: { kind: 'user' as const, id: USER },
    correlationId: 'corr_measurement',
    publicationId,
  });
  const pull = (publicationId: string, pullIndex: number, hours: number, tenantId = tenantA) =>
    inTenant(tenantId, () =>
      collection.pullMetrics({
        ...wfInput(publicationId, tenantId),
        pullIndex,
        windowStart: T0.toISOString(),
        windowEnd: new Date(T0.getTime() + hours * HOUR).toISOString(),
      }),
    );
  const snapshotsOf = (publicationId: string) =>
    tdb.db.select().from(metricSnapshots).where(eq(metricSnapshots.subjectId, publicationId));
  const connect = async (tenantId: string, brandId: string) => {
    const started = await run(tenantId, (tx) =>
      channelService.connect.start(
        analyst(tenantId, 'owner'),
        { brandId, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    return run(tenantId, (tx) =>
      channelService.connect.complete(analyst(tenantId, 'owner'), { state: started.state, code: 'good' }, tx),
    );
  };
  const publishedPublication = async (tenantId: string, brandId: string, channelConnectionId: string) => {
    const id = newId('publication');
    await tdb.db.insert(publications).values({
      id,
      tenantId,
      brandId,
      contentPackageId: newId('contentPackage'),
      contentRevisionId: newId('contentRevision'),
      channelVariantId: newId('channelVariant'),
      channelConnectionId,
      occurrenceKey: `test:${id}`,
      authority: 'approval',
      approvalId: newId('releaseApproval'),
      mandateId: null,
      scheduledFor: T0,
      state: 'published',
      remotePostId: `post_${id.slice(-6)}`,
      remoteUrl: 'https://fixture.example/p/1',
      scheduledByKind: 'user',
      scheduledById: USER,
    });
    const payload = { remotePostId: `post_${id.slice(-6)}` };
    await tdb.db.insert(remoteEvidence).values({
      id: newId('remoteEvidence'),
      tenantId,
      publicationId: id,
      attemptId: null,
      kind: 'accepted_response',
      remotePostId: payload.remotePostId,
      remoteUrl: 'https://fixture.example/p/1',
      payload,
      payloadHash: hashCanonical(payload),
      capturedAt: T0,
    });
    return id;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'measurement-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'measurement-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      {
        id: brandA,
        tenantId: tenantA,
        name: 'A1',
        timezone: 'Europe/Berlin',
        defaultLocale: 'en',
        status: 'active',
      },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    configurePublishingProviders({ registry });
    configureCredentialBroker({ kms: new LocalKms('measurement-test-master-secret-0123456789') });
    registerProviderClients(() => ({ clientId: 'fixture-client', clientSecret: 'fixture-secret' }));
    // What brandService.assertExist does: a brand of another tenant does not exist (spec 5.3).
    const checker = {
      assertExist: async (ids: string[]) => {
        const known = requireTenant().tenantId === tenantA ? brandA : brandB;
        for (const id of ids) if (id !== known) throw new NotFoundError('Brand', id);
      },
    };
    registerPublishingBrandChecker(checker);
    registerBrandChecker(checker);
    configureAuthorHashing({ secret: 'author-hash-secret' });
    configureLinkTracking({ redirectBaseUrl: 'https://ore.link/' });
    registerCommentSink(async (comments) => {
      sinkCalls.push(comments);
    });
    fixture.grant.remoteAccountId = 'acct_A';
    connA = (await connect(tenantA, brandA)).id;
    fixture.grant.remoteAccountId = 'acct_B';
    connB = (await connect(tenantB, brandB)).id;
    pubA = await publishedPublication(tenantA, brandA, connA);
    pubB = await publishedPublication(tenantB, brandB, connB);
  });
  afterAll(async () => {
    resetCommentSinks();
    await tdb?.drop();
  });
  beforeEach(() => {
    fixture.metricsBehaviour = 'ok';
    now = T0;
  });

  describe('metric definitions (spec 15.1)', () => {
    it('seeds global rows from the capability register idempotently, with comparable groups and versions', async () => {
      const first = await definitionService.seedGlobal([fixture.capability]);
      expect(first).toBe(6 + 1 + 3); // post + account metrics + derived rates
      expect(await definitionService.seedGlobal([fixture.capability])).toBe(0);
      const listed = await inTenant(tenantA, () => definitionService.list(A, {}));
      const impressions = listed.find(
        (d) => d.key === 'impressionCount' && d.providerKey === FIXTURE_PROVIDER_KEY,
      );
      expect(impressions).toMatchObject({
        scope: 'global',
        comparableGroup: 'impressions',
        definitionVersion: 1,
        unit: 'count',
      });
      expect(listed.find((d) => d.key === 'audienceRetention')?.aggregation).toBe('series');
      expect(listed.find((d) => d.key === 'engagement_rate')).toMatchObject({
        providerKey: null,
        comparableGroup: 'rate:engagement/impressions',
      });
    });
    it('a tenant defines its own metric; the other tenant cannot see it; a repeat version is a conflict', async () => {
      const created = await run(tenantA, (tx) =>
        definitionService.create(
          A,
          {
            key: 'qualified_enquiries',
            providerKey: null,
            nativeName: 'qualified_enquiries',
            unit: 'count',
            aggregation: 'sum',
            comparableGroup: 'conversions',
            definitionVersion: 1,
            separatesPaidOrganic: false,
          },
          tx,
        ),
      );
      expect(created.scope).toBe('tenant');
      expect(
        await inTenant(tenantA, () => definitionService.get(A, { definitionId: created.id })),
      ).toMatchObject({ key: 'qualified_enquiries' });
      await expect(
        inTenant(tenantB, () => definitionService.get(B, { definitionId: created.id })),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        (await inTenant(tenantB, () => definitionService.list(B, {}))).some((d) => d.id === created.id),
      ).toBe(false);
      await expect(
        run(tenantA, (tx) =>
          definitionService.create(
            A,
            {
              key: 'qualified_enquiries',
              providerKey: null,
              nativeName: 'x',
              unit: 'count',
              aggregation: 'sum',
              comparableGroup: 'conversions',
              definitionVersion: 1,
              separatesPaidOrganic: false,
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      const creator = { ...A, role: 'creator' as const };
      await expect(
        run(tenantA, (tx) =>
          definitionService.create(
            creator,
            {
              key: 'k2',
              providerKey: null,
              nativeName: 'x',
              unit: 'count',
              aggregation: 'sum',
              comparableGroup: 'g',
              definitionVersion: 1,
              separatesPaidOrganic: false,
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
    });
  });

  describe('collection (spec 15.1) and the outbox route', () => {
    it('the plan is derived from the publication moment and the capability latency', async () => {
      const plan = await inTenant(tenantA, () => collection.readCollectionPlan(wfInput(pubA)));
      expect(plan).toEqual({
        collectable: true,
        providerKey: FIXTURE_PROVIDER_KEY,
        publishedAt: T0.toISOString(),
        latencyHours: 2,
        commentsReadable: true,
      });
      await expect(
        inTenant(tenantA, () => collection.readCollectionPlan(wfInput(pubB))),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
    it('a pull writes raw snapshots with provenance; unavailable is a null row, never zero; series stay series', async () => {
      now = new Date(T0.getTime() + 2 * HOUR);
      const result = await pull(pubA, 0, 2);
      expect(result).toEqual({ written: 6 + 3, skipped: 0, unavailable: 1 + 1 });
      const rows = await snapshotsOf(pubA);
      const clicks = rows.find((r) => r.metricKey === 'clickCount');
      expect(clicks).toMatchObject({
        value: null,
        completeness: 'unavailable',
        source: `${FIXTURE_PROVIDER_KEY}@v1`,
        brandTimezone: 'Europe/Berlin',
        definitionVersion: 1,
      });
      expect(clicks?.fetchedAt.toISOString()).toBe(now.toISOString());
      expect(clicks?.windowStart.toISOString()).toBe(T0.toISOString());
      expect(rows.find((r) => r.metricKey === 'impressionCount')).toMatchObject({
        value: 1000,
        completeness: 'complete',
      });
      expect(rows.find((r) => r.metricKey === 'audienceRetention')?.series).toEqual([
        { at: '0', value: 1 },
        { at: '5', value: 0.4 },
      ]);
      expect(rows.every((r) => r.completeness !== 'unavailable' || r.value === null)).toBe(true);
      // Derived rates carry their operands (spec 15.2).
      const rate = rows.find((r) => r.metricKey === 'engagement_rate');
      expect(rate).toMatchObject({ value: 0.05, completeness: 'complete' });
      expect(rate?.numeratorSnapshotId).toBe(rows.find((r) => r.metricKey === 'engagement')?.id);
      expect(rate?.denominatorSnapshotId).toBe(rows.find((r) => r.metricKey === 'impressionCount')?.id);
      expect(rows.find((r) => r.metricKey === 'click_through_rate')).toMatchObject({
        value: null,
        completeness: 'unavailable',
      });
      expect(fixture.metricCalls.at(-1)).toEqual({
        remotePostId: `post_${pubA.slice(-6)}`,
        window: { start: T0.toISOString(), end: now.toISOString() },
      });
    });
    it('a repeat of the same (publication, window) writes nothing; a new window writes again', async () => {
      const before = (await snapshotsOf(pubA)).length;
      expect(await pull(pubA, 0, 2)).toEqual({ written: 0, skipped: 6, unavailable: 0 });
      expect((await snapshotsOf(pubA)).length).toBe(before);
      now = new Date(T0.getTime() + 24 * HOUR);
      expect((await pull(pubA, 1, 24)).written).toBe(9);
      expect((await snapshotsOf(pubA)).length).toBe(before + 9);
    });
    it('a platform failure records the window as unavailable (not zero) and does not fail the pull', async () => {
      fixture.metricsBehaviour = 'fail';
      now = new Date(T0.getTime() + 72 * HOUR);
      expect(await pull(pubA, 2, 72)).toEqual({ written: 9, skipped: 0, unavailable: 9 }); // 6 raw + 3 derived rates
      const rows = (await snapshotsOf(pubA)).filter((r) => r.windowEnd.getTime() === now.getTime());
      expect(rows.every((r) => r.value === null && r.completeness === 'unavailable')).toBe(true);
      expect(rows.some((r) => r.value === 0)).toBe(false);
    });
    it('a foreign publication is NOT_FOUND before any credential is opened', async () => {
      const calls = fixture.metricCalls.length;
      await expect(pull(pubB, 0, 2)).rejects.toBeInstanceOf(NotFoundError);
      expect(fixture.metricCalls.length).toBe(calls);
    });
    it('measurement.collection_due routes to metricCollectionWorkflowV1 on ingest-metrics with a stable id', async () => {
      registerMeasurementOutboxRoutes();
      const route = outboxRouteFor('measurement.collection_due');
      expect(route).toBeDefined();
      const start = route?.({
        id: 'evt_1',
        tenantId: tenantA,
        aggregateType: 'publication',
        aggregateId: pubA,
        aggregateVersion: 1,
        eventType: 'measurement.collection_due',
        schemaVersion: 1,
        payload: {
          publicationId: pubA,
          channelConnectionId: connA,
          actorKind: 'user',
          actorId: USER,
          brandId: brandA,
        },
        correlationId: 'corr',
        attempts: 0,
        availableAt: T0,
        createdAt: T0,
      });
      expect(start).toEqual({
        workflowType: 'metricCollectionWorkflowV1',
        taskQueue: 'ingest-metrics',
        workflowId: `metrics:${pubA}`,
        args: [
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: USER },
            correlationId: 'corr',
            publicationId: pubA,
          },
        ],
      });
    });
  });

  describe('query with freshness and coverage (spec 15.2)', () => {
    const query = (
      windowEndHours: number,
      grouping: 'subject' | 'metric' | 'comparable_group' = 'subject',
      keys = ['impressionCount', 'engagement', 'clickCount', 'engagement_rate', 'audienceRetention', 'nope'],
    ) =>
      inTenant(tenantA, () =>
        metrics.query(A, {
          brandId: brandA,
          subjectType: 'publication',
          subjectIds: [pubA, pubB],
          metricKeys: keys,
          windowStart: T0.toISOString(),
          windowEnd: new Date(T0.getTime() + windowEndHours * HOUR).toISOString(),
          grouping,
        }),
      );
    it('returns the latest fetch per metric with freshness, completeness, provenance and coverage', async () => {
      now = new Date(T0.getTime() + 25 * HOUR);
      const res = await query(24);
      const impressions = res.values.find((v) => v.metricKey === 'impressionCount');
      expect(impressions).toMatchObject({
        value: 1000,
        completeness: 'complete',
        comparableGroup: 'impressions',
        source: `${FIXTURE_PROVIDER_KEY}@v1`,
        brandTimezone: 'Europe/Berlin',
      });
      expect(impressions?.freshness).toMatchObject({ latencyHours: 2, stale: false, ageHours: 1 });
      expect(impressions?.windowEnd).toBe(new Date(T0.getTime() + 24 * HOUR).toISOString());
      expect(res.values.find((v) => v.metricKey === 'clickCount')).toMatchObject({
        value: null,
        completeness: 'unavailable',
      });
      expect(res.values.find((v) => v.metricKey === 'audienceRetention')?.series).toHaveLength(2);
      expect(res.values.find((v) => v.metricKey === 'engagement_rate')?.numeratorSnapshotId).toBeTruthy();
      expect(res.coverage).toMatchObject({
        subjectsRequested: 2,
        subjectsWithData: 1,
        metricsUnavailable: ['clickCount', 'nope'],
        staleValues: 0,
      });
      expect(res.groups.map((g) => g.key)).toEqual([pubA]); // pubB is another tenant's: no data, no leak
    });
    it('marks values stale beyond latency × 2 and aggregates only within a comparable group', async () => {
      now = new Date(T0.getTime() + 24 * HOUR + 5 * HOUR);
      const res = await query(24, 'comparable_group');
      expect(res.values.every((v) => v.freshness.stale)).toBe(true);
      expect(res.coverage.staleValues).toBe(res.values.length);
      const groups = res.aggregates.map((a) => a.comparableGroup);
      expect(groups).toContain('impressions');
      expect(groups).toContain('engagement');
      expect(res.aggregates.find((a) => a.comparableGroup === 'impressions')).toMatchObject({
        value: 1000,
        stale: true,
        subjectsWithData: 1,
      });
      expect(res.aggregates.find((a) => a.comparableGroup === 'clicks')).toMatchObject({
        value: null,
        subjectsUnavailable: 1,
      });
    });
    it('a foreign brand is NOT_FOUND', async () => {
      await expect(
        inTenant(tenantA, () =>
          metrics.query(A, {
            brandId: brandB,
            subjectType: 'publication',
            subjectIds: [pubB],
            metricKeys: ['impressionCount'],
            windowStart: T0.toISOString(),
            windowEnd: now.toISOString(),
            grouping: 'subject',
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('comment ingestion (spec 16.5, read-only) and engagement quality (spec 15.3)', () => {
    it('ingests comments once each with per-tenant salted author hashes and notifies the sink', async () => {
      fixture.commentPages = [
        {
          items: [
            {
              remoteCommentId: 'c1',
              authorHandle: '@Alice',
              text: 'Where can I buy this?',
              createdAt: T0.toISOString(),
            },
            {
              remoteCommentId: 'c2',
              authorHandle: '@bob',
              text: 'nice',
              createdAt: new Date(T0.getTime() + 60_000).toISOString(),
            },
          ],
          nextCursor: '1',
        },
        {
          items: [
            {
              remoteCommentId: 'c3',
              authorHandle: '@alice',
              text: 'Thanks!',
              createdAt: new Date(T0.getTime() + 120_000).toISOString(),
            },
          ],
        },
      ];
      const first = await inTenant(tenantA, () =>
        ingestion.pullComments({ ...wfInput(pubA), pullIndex: 0, since: null, cursor: null }),
      );
      expect(first).toEqual({ ingested: 2, duplicates: 0, nextCursor: '1' });
      const second = await inTenant(tenantA, () =>
        ingestion.pullComments({ ...wfInput(pubA), pullIndex: 0, since: null, cursor: '1' }),
      );
      expect(second).toEqual({ ingested: 1, duplicates: 0, nextCursor: null });
      const again = await inTenant(tenantA, () =>
        ingestion.pullComments({ ...wfInput(pubA), pullIndex: 1, since: null, cursor: null }),
      );
      expect(again).toEqual({ ingested: 0, duplicates: 2, nextCursor: '1' });
      const stored = await tdb.db.select().from(messages).where(eq(messages.tenantId, tenantA));
      expect(stored).toHaveLength(3);
      const alice = authorHash('author-hash-secret', tenantA, '@Alice');
      expect(stored.filter((m) => m.authorHash === alice)).toHaveLength(2); // case-insensitive, same person
      expect(stored.every((m) => m.authorHash !== '@Alice' && m.authorHash.length === 64)).toBe(true);
      expect(authorHash('author-hash-secret', tenantB, '@Alice')).not.toBe(alice); // per-tenant salt
      expect(sinkCalls.flat().map((c) => c.text)).toEqual(['Where can I buy this?', 'nice', 'Thanks!']);
      expect(sinkCalls.flat()[0]).toMatchObject({
        publicationId: pubA,
        brandId: brandA,
        channelConnectionId: connA,
      });
      await expect(
        inTenant(tenantA, () =>
          ingestion.pullComments({ ...wfInput(pubB), pullIndex: 0, since: null, cursor: null }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
    it('the quality composite uses brand weights, drills down to components and names what is unavailable', async () => {
      now = new Date(T0.getTime() + 25 * HOUR);
      const window = {
        windowStart: T0.toISOString(),
        windowEnd: new Date(T0.getTime() + 24 * HOUR).toISOString(),
      };
      const before = await inTenant(tenantA, () =>
        metrics.quality(A, { brandId: brandA, publicationId: pubA, ...window }),
      );
      expect(before.weightsSource).toBe('default');
      expect(before.unavailable).toEqual(['substantive_comments', 'negative_feedback']); // not classified yet; no negative metric
      expect(before.components.find((c) => c.component === 'repeat_engagers')).toMatchObject({
        value: 1,
        available: true,
      });
      expect(before.components.find((c) => c.component === 'saves')).toMatchObject({
        value: 8,
        normalised: 8,
      });
      expect(before.impressionsBase).toBe(1000);
      // The classifier (intelligence module) marks substantive comments; the brand sets weights on its objective.
      await tdb.db
        .update(messages)
        .set({ substantive: 'yes' })
        .where(and(eq(messages.tenantId, tenantA), eq(messages.remoteMessageId, 'c1')));
      await tdb.db
        .update(messages)
        .set({ substantive: 'no' })
        .where(and(eq(messages.tenantId, tenantA), eq(messages.remoteMessageId, 'c2')));
      await tdb.db.insert(brandObjectives).values({
        id: newId('brandObjective'),
        tenantId: tenantA,
        brandId: brandA,
        name: 'Enquiries',
        primaryMetricKey: 'qualified_enquiries',
        guardrailMetricKeys: [],
        engagementQualityWeights: {
          saves: 2,
          shares: 1,
          substantive_comments: 3,
          repeat_engagers: 1,
          negative_feedback: 1,
        },
        activeFrom: new Date(T0.getTime() - HOUR),
        activeUntil: null,
      });
      const after = await inTenant(tenantA, () =>
        metrics.quality(A, { brandId: brandA, publicationId: pubA, ...window }),
      );
      expect(after.weightsSource).toBe('brand_objective');
      expect(after.unavailable).toEqual(['negative_feedback']);
      expect(after.components.find((c) => c.component === 'substantive_comments')).toMatchObject({
        value: 1,
        weight: 3,
      });
      expect(after.score).toBe(Math.round(((2 * 8 + 1 * 4 + 3 * 1 + 1 * 1) / 7) * 1000) / 1000);
      expect(after.freshness.every((f) => f.stale === false)).toBe(true);
      await expect(
        inTenant(tenantA, () => metrics.quality(A, { brandId: brandA, publicationId: pubB, ...window })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('tracked links (spec 15.4)', () => {
    it('rewrites variant URLs to the redirect domain and the redirector resolves the code to the UTM destination', async () => {
      const variantId = newId('channelVariant');
      const revisionId = newId('contentRevision');
      const text = await run(tenantA, (tx) =>
        linkService.trackVariantLinks(
          {
            brandId: brandA,
            contentRevisionId: revisionId,
            channelVariantId: variantId,
            channelConnectionId: connA,
            text: 'Read https://example.test/post?ref=1 now. Again: https://example.test/post?ref=1',
          },
          tx,
        ),
      );
      const code = text.match(/https:\/\/ore\.link\/([A-Za-z0-9_-]+)/)?.[1] ?? '';
      expect(code).toMatch(SHORT_CODE_PATTERN);
      expect(text).toBe(`Read https://ore.link/${code} now. Again: https://ore.link/${code}`);
      // What apps/redirector/src/links.ts does: a global lookup by short_code returning the ids a click needs.
      const resolved = (await tdb.db.select().from(trackedLinks).where(eq(trackedLinks.shortCode, code)))[0];
      expect(resolved).toMatchObject({ tenantId: tenantA, brandId: brandA, variantId, publicationId: null });
      expect(resolved?.destination).toBe(
        `https://example.test/post?ref=1&utm_source=oremedia&utm_medium=social&utm_campaign=${revisionId}&utm_content=${variantId}`,
      );
      expect(resolved?.utm).toEqual({
        utm_source: 'oremedia',
        utm_medium: 'social',
        utm_campaign: revisionId,
        utm_content: variantId,
      });
      // The redirector's buffered click rows (visitor hash is its keyed hash; the module only counts).
      await tdb.db.insert(linkClicks).values([
        {
          id: newId('trackedLink').replace('tl_', 'lc_'),
          tenantId: tenantA,
          brandId: brandA,
          trackedLinkId: resolved?.id ?? '',
          visitorHash: 'v1'.padEnd(64, '0'),
          occurredAt: T0,
        },
        {
          id: newId('trackedLink').replace('tl_', 'lc_'),
          tenantId: tenantA,
          brandId: brandA,
          trackedLinkId: resolved?.id ?? '',
          visitorHash: 'v1'.padEnd(64, '0'),
          occurredAt: T0,
        },
        {
          id: newId('trackedLink').replace('tl_', 'lc_'),
          tenantId: tenantA,
          brandId: brandA,
          trackedLinkId: resolved?.id ?? '',
          visitorHash: 'v2'.padEnd(64, '0'),
          occurredAt: T0,
        },
      ]);
      const listed = await inTenant(tenantA, () =>
        linkService.list(A, { brandId: brandA, variantId, page: { limit: 50 } }),
      );
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({
        shortCode: code,
        clicks: 3,
        shortUrl: `https://ore.link/${code}`,
      });
      expect(listed.uniqueVisitors).toBe(2);
      await expect(
        inTenant(tenantB, () => linkService.list(B, { brandId: brandA, variantId, page: { limit: 50 } })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
    it('without a redirect domain the text is left as written', async () => {
      configureLinkTracking({ redirectBaseUrl: null });
      const text = await run(tenantA, (tx) =>
        linkService.trackVariantLinks(
          {
            brandId: brandA,
            contentRevisionId: 'pr',
            channelVariantId: 'cv',
            channelConnectionId: connA,
            text: 'https://example.test/x',
          },
          tx,
        ),
      );
      expect(text).toBe('https://example.test/x');
      configureLinkTracking({ redirectBaseUrl: 'https://ore.link' });
    });
  });

  describe('creative attributes (spec 16.2)', () => {
    it('captures copy and layout features at creation; a human correction records its source; foreign ids are NOT_FOUND', async () => {
      const documentId = newId('creativeDocument');
      const creativeRevisionId = newId('creativeRevision');
      const snapshot = {
        schemaVersion: 1 as const,
        brandVersionId: 'bv_1',
        templateVersionId: 'tv_1',
        pages: [
          {
            id: 'pg',
            elements: [
              {
                id: 'el_h',
                type: 'text',
                name: 'Headline',
                semanticRole: 'headline',
                text: 'Hi',
                style: { typeRole: 'display', colourToken: 'ink' },
              },
              { id: 'el_i', type: 'image', name: 'Product', semanticRole: 'product', assetVersionId: 'av_1' },
            ],
          },
        ],
        variants: [],
      };
      await tdb.db.insert(creativeDocuments).values({
        id: documentId,
        tenantId: tenantA,
        brandId: brandA,
        title: 'Doc',
        contentPackageId: null,
        currentRevisionId: creativeRevisionId,
        schemaVersion: 1,
      });
      await tdb.db.insert(creativeRevisions).values({
        id: creativeRevisionId,
        tenantId: tenantA,
        brandId: brandA,
        documentId,
        parentRevisionId: null,
        number: 1,
        brandVersionId: 'bv_1',
        agentRunId: null,
        authorKind: 'user',
        authorId: USER,
        changeSummary: 'seed',
        operations: { ops: [] },
        snapshot,
        contentHash: hashCanonical(snapshot),
      } as never);
      const contentRevisionId = newId('contentRevision');
      const id = await run(tenantA, (tx) =>
        attributeService.capture(
          {
            brandId: brandA,
            contentRevisionId,
            copy: { schemaVersion: 1, master: { text: 'Tired of waiting? Shop now.', factRefs: ['fact_1'] } },
            creativeRevisionIds: [creativeRevisionId],
            authorKind: 'agent',
          },
          tx,
        ),
      );
      const captured = await inTenant(tenantA, () => attributeService.get(A, { contentRevisionId }));
      expect(captured).toMatchObject({
        id,
        source: 'captured',
        attributes: {
          hookType: 'question',
          cta: 'Shop now.',
          offerFactId: 'fact_1',
          templateVersionId: 'tv_1',
          layoutKey: 'headline+product',
          imageryKind: 'product',
          typographyRoles: ['display'],
          colourTreatment: 'tokens',
          distribution: 'agent',
        },
      });
      const corrected = await run(tenantA, (tx) =>
        attributeService.correct(
          analyst(tenantA, 'owner'),
          {
            attributeId: id,
            expectedVersion: 0,
            attributes: { hookType: 'pain_point', imageryKind: 'people' },
          },
          tx,
        ),
      );
      expect(corrected).toMatchObject({
        source: 'human_corrected',
        version: 1,
        attributes: { hookType: 'pain_point', imageryKind: 'people', cta: 'Shop now.' },
      });
      expect(
        (await tdb.db.select().from(creativeAttributes).where(eq(creativeAttributes.id, id)))[0]?.source,
      ).toBe('human_corrected');
      await expect(
        inTenant(tenantB, () => attributeService.get(B, { attributeId: id })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantB, (tx) =>
          attributeService.correct(
            analyst(tenantB, 'owner'),
            { attributeId: id, expectedVersion: 1, attributes: { cta: 'x' } },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      const reviewer = { ...A, role: 'reviewer' as const };
      await expect(
        run(tenantA, (tx) =>
          attributeService.correct(
            reviewer,
            { attributeId: id, expectedVersion: 1, attributes: { cta: 'x' } },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
    });
  });

  it('the published event the publishing runtime emits for collection is in the catalogue and untouched here', async () => {
    const rows = await tdb.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'measurement.collection_due'));
    expect(rows).toEqual([]); // this suite drives the runtime directly; the event is emitted by markPublished (publishing tests)
    expect(
      (await tdb.db.select().from(metricDefinitions).where(eq(metricDefinitions.key, 'impressionCount')))
        .length,
    ).toBeGreaterThan(0);
  });
});
