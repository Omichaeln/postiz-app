import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  defaultPolicyDocument,
  emptyBrandSystemDocument,
  type BrandSystemDocumentV1,
} from '@oremedia/contracts/brand';
import type { BrandChangeImpactInputV1 } from '@oremedia/contracts/brand-change-impact';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { publications } from '@oremedia/db/schema/publishing';
import { releaseApprovals } from '@oremedia/db/schema/review';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createBrandChangeImpactActivities } from '@oremedia/activities';
import { brandService } from '@oremedia/module-brand';
import { contentService } from '@oremedia/module-content';
import { outboxRouteFor } from '@oremedia/module-operations';
import {
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  configurePublishingProviders,
  publicationService,
  registerProviderClients,
} from '@oremedia/module-publishing';
import { BRAND_CHANGE_IMPACT_WORKFLOW_TYPE, reviewService } from '@oremedia/module-review';
import { ProviderRegistry } from '@oremedia/providers';
import { runBrandChangeImpact } from '@oremedia/workflows/brand-change-impact.workflow.v1';
import { createBrandChangeImpactRuntime } from './brand-change-runtime';
import { composeModules } from './composition';

/**
 * Spec 8.2 (ledger 2.9, 2.10) end to end against MySQL through the real composition root: the brand module's
 * events are routed by the review module to brandChangeImpactWorkflowV1 on `core`, whose activities (the real
 * runtime: review, content and publishing modules, the real release evaluator) invalidate the brand's approvals,
 * hold the scheduled publications a published version no longer covers (approval_matches), hold the ones a
 * revoked fact reaches under the default policy (facts_valid) or only flag them when the policy says so, and do
 * nothing on a second run.
 */
const USER = 'usr_e2e_brand_change';
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newId = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => ULID_ALPHABET[Math.floor(Math.random() * 32)]).join('')}`;
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_e2e_brand_change',
});
const owner = (tenantId: string): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_e2e_brand_change',
  membershipStatus: 'active',
  role: 'owner',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});

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

describe('brand change impact end to end (worker-core composition, real activities)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const brandA = newId('brd');
  const actor = owner(tenantA);
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter();
  registry.register(fixture);
  const acts = createBrandChangeImpactActivities(createBrandChangeImpactRuntime());
  const at = new Date('2027-06-01T09:00:00.000Z');
  let connA = '';

  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx(tenantA), () => withTransaction(fn));
  const row = async (id: string) =>
    (await tdb.db.select().from(publications).where(eq(publications.id, id)))[0]!;
  const approvalRow = async (id: string) =>
    (await tdb.db.select().from(releaseApprovals).where(eq(releaseApprovals.id, id)))[0]!;
  const eventsOf = (type: string) =>
    tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, type)));
  const auditOf = (action: string, resourceId: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, tenantA),
          eq(auditEvents.action, action),
          eq(auditEvents.resourceId, resourceId),
        ),
      );

  /** The workflow input the review module's outbox route builds from the newest event of a type. */
  async function routedInput(type: 'brand.version_published' | 'brand.fact_revoked') {
    const events = await eventsOf(type);
    const evt = events[events.length - 1]!;
    const req = outboxRouteFor(evt.eventType)!({ ...evt, payload: evt.payload })!;
    expect(req).toMatchObject({
      workflowType: BRAND_CHANGE_IMPACT_WORKFLOW_TYPE,
      taskQueue: 'core',
      workflowId: `brand-change:${evt.id}`,
    });
    return req.args[0] as BrandChangeImpactInputV1;
  }

  async function publishBrandVersion() {
    const draft = await run((tx) => brandService.versions.createDraft(actor, { brandId: brandA }, tx));
    await run((tx) =>
      brandService.versions.update(
        actor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 0, document: brandDocument() },
        tx,
      ),
    );
    await run((tx) =>
      brandService.versions.submitForReview(
        actor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 1 },
        tx,
      ),
    );
    await run((tx) =>
      brandService.versions.publish(
        actor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 2 },
        tx,
      ),
    );
    return draft.versionId;
  }
  async function activatePolicy(holdOnDependencyRevocation: boolean) {
    const pv = await run((tx) =>
      brandService.policy.createVersion(
        actor,
        { brandId: brandA, document: { ...defaultPolicyDocument(), holdOnDependencyRevocation } },
        tx,
      ),
    );
    await run((tx) =>
      brandService.policy.activate(
        actor,
        { brandId: brandA, policyVersionId: pv.policyVersionId, expectedVersion: 0 },
        tx,
      ),
    );
  }
  async function approvedFact(statement: string) {
    const fact = await run((tx) =>
      brandService.facts.propose(
        actor,
        { brandId: brandA, kind: 'offer', statement, evidence: [{ kind: 'other', ref: 'test' }] },
        tx,
      ),
    );
    await run((tx) =>
      brandService.facts.approve(actor, { brandId: brandA, factId: fact.factId, expectedVersion: 0 }, tx),
    );
    return fact.factId;
  }
  /** A package citing the facts, reviewed and approved, scheduled at the approved time: one scheduled publication. */
  async function scheduledPublication(title: string, factRefs: string[]) {
    const pkg = await run((tx) =>
      contentService.packages.create(
        actor,
        {
          brandId: brandA,
          title,
          copy: { schemaVersion: 1, master: { text: `${title} caption`, factRefs } },
          creativeDocumentIds: [],
        },
        tx,
      ),
    );
    const gen = await run((tx) =>
      contentService.variants.generate(
        actor,
        { contentRevisionId: pkg.contentRevisionId, channelConnectionIds: [connA] },
        tx,
      ),
    );
    const req = await run((tx) =>
      reviewService.requests.create(
        actor,
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
        actor,
        { reviewRequestId: req.reviewRequestId, decision: 'approve', expectedManifestHash: req.manifestHash },
        tx,
      ),
    );
    const pub = await run((tx) =>
      publicationService.schedule(
        actor,
        {
          channelVariantId: gen.created[0]!,
          scheduledFor: at.toISOString(),
          authority: 'approval',
          approvalId: decided.approvalId!,
        },
        tx,
      ),
    );
    expect(await row(pub.id)).toMatchObject({ state: 'scheduled' });
    return { publicationId: pub.id, approvalId: decided.approvalId!, revisionId: pkg.contentRevisionId };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values({ id: tenantA, name: 'A', slug: 'e2e-brand-change-a' });
    await tdb.db.insert(users).values({ id: USER, email: 'e2e-brand-change@example.test', name: 'Owner' });
    await tdb.db.insert(memberships).values({
      id: 'mem_e2e_brand_change',
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
    // The real composition root (routes, the release evaluator and every cross-module hook); only the seams a
    // test controls (providers, KMS, client secrets) are re-registered afterwards, as the worker does.
    composeModules();
    configurePublishingProviders({ registry });
    configureCredentialBroker({ kms: new LocalKms('e2e-brand-change-master-secret-0123456789') });
    registerProviderClients(() => ({ clientId: 'c', clientSecret: 's' }));
    const started = await run((tx) =>
      channelService.connect.start(
        actor,
        { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
        tx,
      ),
    );
    connA = (
      await run((tx) => channelService.connect.complete(actor, { state: started.state, code: 'good' }, tx))
    ).id;
    await publishBrandVersion();
    await activatePolicy(true);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('a published brand version invalidates the approvals and holds the scheduled publication (approval_matches); a second run is a no-op', async () => {
    const pub = await scheduledPublication('Version change', []);
    await publishBrandVersion();
    const input = await routedInput('brand.version_published');
    expect(input).toMatchObject({
      tenantId: tenantA,
      actor: { kind: 'user', id: USER },
      brandId: brandA,
      change: { kind: 'version_published' },
    });

    const result = await runBrandChangeImpact(acts, input);
    expect(result).toMatchObject({ approvalsInvalidated: 1, publicationsHeld: 1, publicationsFlagged: 0 });
    expect(await approvalRow(pub.approvalId)).toMatchObject({
      state: 'invalidated',
      invalidatedReason: 'brand_changed',
    });
    const held = await row(pub.publicationId);
    expect(held.state).toBe('held');
    expect(held.holdReasons).toEqual(expect.arrayContaining(['approval_valid', 'approval_matches']));
    expect(held.stateReason).toBe('brand_version_published');
    const holds = await auditOf('publication.hold', pub.publicationId);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.metadata).toMatchObject({ fromState: 'scheduled', toState: 'held' });
    expect(
      (await eventsOf('publication.state_changed')).filter(
        (e) => e.aggregateId === pub.publicationId && e.payload['toState'] === 'held',
      ),
    ).toHaveLength(1);

    const again = await runBrandChangeImpact(acts, input);
    expect(again).toEqual({
      approvalsInvalidated: 0,
      requestsStaled: 0,
      publicationsHeld: 0,
      publicationsFlagged: 0,
      publicationsUnchanged: 0,
    });
    expect(await row(pub.publicationId)).toMatchObject({ state: 'held', version: held.version });
  });

  it('a revoked fact under the default policy holds the scheduled publications citing it (facts_valid) and leaves the others scheduled', async () => {
    const fact = await approvedFact('20% off in June');
    const citing = await scheduledPublication('Cites the fact', [fact]);
    const other = await scheduledPublication('Cites nothing', []);
    await run((tx) =>
      brandService.facts.revoke(
        actor,
        { brandId: brandA, factId: fact, expectedVersion: 1, reason: 'offer withdrawn' },
        tx,
      ),
    );
    const input = await routedInput('brand.fact_revoked');
    expect(input).toMatchObject({ brandId: brandA, change: { kind: 'fact_revoked', factId: fact } });

    const result = await runBrandChangeImpact(acts, input);
    expect(result).toMatchObject({ approvalsInvalidated: 2, publicationsHeld: 1, publicationsFlagged: 0 });
    const held = await row(citing.publicationId);
    expect(held.state).toBe('held');
    expect(held.holdReasons).toEqual(expect.arrayContaining(['facts_valid']));
    expect(held.stateReason).toBe(`fact_revoked:${fact}`);
    // The other publication is not reached by the fact: its approval is invalidated (spec 13.2), its state kept.
    expect(await row(other.publicationId)).toMatchObject({ state: 'scheduled' });
    expect(await approvalRow(other.approvalId)).toMatchObject({ state: 'invalidated' });

    const again = await runBrandChangeImpact(acts, input);
    expect(again).toMatchObject({ approvalsInvalidated: 0, publicationsHeld: 0, publicationsFlagged: 0 });
    expect(await row(citing.publicationId)).toMatchObject({ state: 'held', version: held.version });
  });

  it('a revoked fact under holdOnDependencyRevocation=false only flags the publication: needs-attention audit and event, state unchanged', async () => {
    await activatePolicy(false);
    const fact = await approvedFact('Free delivery in July');
    const citing = await scheduledPublication('Flag only', [fact]);
    const before = await row(citing.publicationId);
    await run((tx) =>
      brandService.facts.revoke(actor, { brandId: brandA, factId: fact, expectedVersion: 1 }, tx),
    );
    const input = await routedInput('brand.fact_revoked');

    const result = await runBrandChangeImpact(acts, input);
    expect(result).toMatchObject({ publicationsHeld: 0, publicationsFlagged: 1, publicationsUnchanged: 0 });
    expect(await row(citing.publicationId)).toMatchObject({
      state: 'scheduled',
      version: before.version,
      holdReasons: null,
    });
    const flagged = await auditOf('publication.needs_attention', citing.publicationId);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.metadata).toMatchObject({
      brandId: brandA,
      revisionId: citing.revisionId,
      reason: `fact_revoked:${fact}`,
    });
    const events = (await eventsOf('publication.needs_attention')).filter(
      (e) => e.aggregateId === citing.publicationId,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      publicationId: citing.publicationId,
      contentRevisionId: citing.revisionId,
      state: 'scheduled',
      brandId: brandA,
    });
    expect(outboxRouteFor('publication.needs_attention')).toBeUndefined(); // informational: nothing to start
  });
});
