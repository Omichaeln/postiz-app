import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { ChannelVariantForPublishing, PublicationWorkflowInputV1 } from '@oremedia/contracts/publishing';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { creativeDocuments, creativeRevisions, renderedExports } from '@oremedia/db/schema/creative';
import { auditEvents } from '@oremedia/db/schema/operations';
import { publicationAttempts, publications } from '@oremedia/db/schema/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createPublishControlActivities, createPublishProviderActivities } from '@oremedia/activities';
import { MemoryStorageProvider, configureStorage } from '@oremedia/module-assets';
import {
  EXPORT_HASH_MISMATCH,
  FIXTURE_PROVIDER_KEY,
  FixtureProviderAdapter,
  LocalKms,
  channelService,
  configureCredentialBroker,
  configurePublishingProviders,
  createPublishingRuntime,
  publicationService,
  registerProviderClients,
  registerApprovalConsumer,
  registerReleaseEvaluator,
  registerVariantSource,
} from '@oremedia/module-publishing';
import { ProviderRegistry } from '@oremedia/providers';
import { runPublication, type PublicationHost } from '@oremedia/workflows/publication.workflow.v1';
import { composeModules } from './composition';

/**
 * Spec 9.3 / 14.3 / 3.g4 through the real composition root: a variant with a rendered export publishes with a
 * signed release URL minted at dispatch (the creative module's export row, the assets module's release copy and
 * URL, the provider receives it); the capability check never mints; an export whose bytes were tampered with
 * after approval holds the publication with reason export_hash_mismatch and nothing is sent.
 */
const USER = 'usr_e2e_media_publisher';
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Prefixed ULID-shaped ids without a dependency on @oremedia/domain (as publishing.integration.test.ts does). */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newId = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => ULID_ALPHABET[Math.floor(Math.random() * 32)]).join('')}`;
const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds: 'all',
  correlationId: 'corr_e2e_media',
});
const publisher = (tenantId: string) => ({
  kind: 'user' as const,
  id: USER,
  tenantId,
  membershipId: 'mem_e2e_media',
  membershipStatus: 'active' as const,
  role: 'owner' as const,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});

describe('publish media source end to end (worker-core composition, fake Temporal host)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const brandA = newId('brd');
  const revisionId = newId('crv');
  const registry = new ProviderRegistry();
  const fixture = new FixtureProviderAdapter();
  registry.register(fixture);
  const mem = new MemoryStorageProvider();
  const variantsById = new Map<string, ChannelVariantForPublishing>();
  const runtime = createPublishingRuntime();
  const control = createPublishControlActivities(runtime.control);
  const provider = createPublishProviderActivities(runtime.provider);
  let connA = '';

  const wfInput = (publicationId: string): PublicationWorkflowInputV1 => ({
    tenantId: tenantA,
    actor: { kind: 'user', id: USER },
    correlationId: 'corr_e2e_media',
    publicationId,
  });
  const inTenant = <T>(fn: () => Promise<T>) => runInTenant(ctx(tenantA), fn);
  const row = async (id: string) =>
    (await tdb.db.select().from(publications).where(eq(publications.id, id)))[0]!;
  const attemptsOf = (id: string) =>
    tdb.db.select().from(publicationAttempts).where(eq(publicationAttempts.publicationId, id));
  const auditOf = (action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, action)));
  const releaseKeys = () => mem.keys().filter((k) => k.startsWith('releases/'));

  /** An export row as the render worker records it (spec 11.5), with its bytes in the object store. */
  async function seedExport(bytes: Buffer) {
    const id = newId('rex');
    const storageKey = `assets/${tenantA}/${brandA}/exports/${revisionId}/${newId('rjb')}/page_1-square_1080.png`;
    await inTenant(() => mem.putObject(storageKey, bytes, { contentType: 'image/png' }));
    await tdb.db.insert(renderedExports).values({
      id,
      tenantId: tenantA,
      brandId: brandA,
      revisionId,
      pageId: 'page_1',
      formatKey: 'square_1080',
      mime: 'image/png',
      width: 1080,
      height: 1080,
      bytes: bytes.length,
      storageKey,
      contentHash: sha256(bytes),
      rendererVersion: 'renderer-test',
      manifest: {
        rendererVersion: 'renderer-test',
        fonts: [],
        assets: [],
        brandVersionId: 'bv_media',
        revisionContentHash: 'd'.repeat(64),
      },
      validation: { ok: true, findings: [] },
    });
    return { id, storageKey, contentHash: sha256(bytes) };
  }
  const newVariant = (text: string, exp: { id: string; contentHash: string }) => {
    const id = newId('cv');
    const v: ChannelVariantForPublishing = {
      id,
      tenantId: tenantA,
      brandId: brandA,
      contentPackageId: 'pkg_e2e_media',
      contentRevisionId: `pr_${id.slice(3)}`,
      channelConnectionId: connA,
      text,
      altTexts: ['A square visual'],
      settings: {},
      exportIds: [exp.id],
      exportHashes: [exp.contentHash],
      version: 0,
    };
    variantsById.set(id, v);
    return v;
  };
  const schedule = (variantId: string) =>
    inTenant(() =>
      withTransaction((tx) =>
        publicationService.schedule(
          publisher(tenantA),
          {
            channelVariantId: variantId,
            scheduledFor: new Date(Date.now() - 1000).toISOString(),
            authority: 'approval',
            approvalId: 'apr_e2e_media',
          },
          tx,
        ),
      ),
    );
  const host = (): PublicationHost => ({
    workflowId: 'pub:e2e-media',
    runId: '11111111-2222-3333-4444-666666666666',
    cancelRequested: () => false,
    takeRescheduled: () => false,
    now: () => Date.now(),
    waitForSignal: async () => undefined,
    sleep: async () => undefined,
    providerActivities: () => ({ publish: provider, lookup: provider }),
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values({ id: tenantA, name: 'A', slug: 'e2e-media-a' });
    await tdb.db
      .insert(users)
      .values({ id: USER, email: 'e2e-media-publisher@example.test', name: 'Publisher' });
    await tdb.db.insert(memberships).values({
      id: 'mem_e2e_media',
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
    const documentId = newId('cdc');
    await tdb.db
      .insert(creativeDocuments)
      .values({ id: documentId, tenantId: tenantA, brandId: brandA, title: 'Visual', schemaVersion: 1 });
    await tdb.db.insert(creativeRevisions).values({
      id: revisionId,
      tenantId: tenantA,
      brandId: brandA,
      documentId,
      number: 1,
      brandVersionId: 'bv_media',
      authorKind: 'user',
      authorId: USER,
      changeSummary: 'seed',
      operations: { baseRevisionId: '', summary: 'seed', origin: 'user', operations: [] },
      snapshot: { schemaVersion: 1, brandVersionId: 'bv_media', pages: [], variants: [] },
      contentHash: 'c'.repeat(64),
    });
    configureStorage(mem);
    // The real composition root (the media source is what this test is about); the seams a test controls
    // (providers, KMS, the release decision, the variant rows) are re-registered afterwards, as the worker does.
    composeModules();
    configurePublishingProviders({ registry, insecureAllowLoopback: true }); // the fixture's send is a loopback call
    configureCredentialBroker({ kms: new LocalKms('e2e-media-master-secret-0123456789abcdef') });
    registerProviderClients(() => ({ clientId: 'c', clientSecret: 's' }));
    registerVariantSource(async (id) => {
      const v = variantsById.get(id);
      if (!v) throw new NotFoundError('ChannelVariant', id);
      return v;
    });
    registerReleaseEvaluator(async () => ({ allow: true }));
    registerApprovalConsumer(async () => undefined); // the review module's consume is not under test here
    const started = await inTenant(() =>
      withTransaction((tx) =>
        channelService.connect.start(
          publisher(tenantA),
          { brandId: brandA, providerKey: FIXTURE_PROVIDER_KEY, redirectUri: 'https://app.example/cb' },
          tx,
        ),
      ),
    );
    connA = (
      await inTenant(() =>
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
  });

  it('the capability check describes the export (dimensions, mime, bytes) and mints nothing', async () => {
    const exp = await seedExport(Buffer.from('png-bytes-describe'));
    const v = newVariant('Describe only', exp);
    expect(await inTenant(() => channelService.validateVariantDetailed(v.id))).toMatchObject({ ok: true });
    expect(releaseKeys()).toEqual([]);
    expect(await auditOf('asset.release_minted')).toHaveLength(0);
  });

  it('a variant with an export publishes with a signed release URL the provider receives', async () => {
    const bytes = Buffer.from('png-bytes-published');
    const exp = await seedExport(bytes);
    const v = newVariant('With media', exp);
    const pub = await schedule(v.id);
    expect(releaseKeys()).toEqual([]); // scheduling never mints (spec 9.3)
    const postsBefore = fixture.posts.length;
    await runPublication(control, wfInput(pub.id), host());
    expect(await row(pub.id)).toMatchObject({ state: 'published' });
    const post = fixture.posts[fixture.posts.length - 1]!;
    expect(fixture.posts).toHaveLength(postsBefore + 1);
    expect(post.media).toHaveLength(1);
    const media = post.media[0]!;
    const releaseKey = releaseKeys().find((k) => media.url.includes(k));
    expect(releaseKey).toBeDefined();
    expect(releaseKey).toMatch(new RegExp(`^releases/${tenantA}/${brandA}/${exp.id}/export/`));
    expect(media).toMatchObject({
      mime: 'image/png',
      width: 1080,
      height: 1080,
      bytes: bytes.length,
      contentHash: exp.contentHash,
      altText: 'A square visual',
    });
    // The release copy is byte-identical to the export; the window is the provider's (fixture capability).
    expect(sha256((await inTenant(() => mem.getObject(releaseKey!)))!)).toBe(exp.contentHash);
    const expires = Number(new URL(media.url).searchParams.get('expires'));
    const windowSec = fixture.capability.media.publicUrlFetch.processingWindowSec;
    expect(expires).toBeGreaterThan(Date.now() + (windowSec - 60) * 1000);
    const minted = await auditOf('asset.release_minted');
    expect(minted.map((a) => a.resourceId)).toContain(exp.id);
    expect(minted.find((a) => a.resourceId === exp.id)!.metadata).toEqual({
      brandId: brandA,
      path: releaseKey,
      reason: `window:${windowSec}s`,
    });
  });

  it('an export whose bytes changed after approval holds the publication (export_hash_mismatch) and sends nothing', async () => {
    const exp = await seedExport(Buffer.from('png-bytes-approved'));
    const v = newVariant('Tampered', exp);
    const pub = await schedule(v.id);
    await inTenant(() =>
      mem.putObject(exp.storageKey, Buffer.from('png-bytes-TAMPERED'), { contentType: 'image/png' }),
    );
    const postsBefore = fixture.posts.length;
    const mintedBefore = (await auditOf('asset.release_minted')).length;
    const releasesBefore = releaseKeys().length;
    await runPublication(control, wfInput(pub.id), host()); // completes: markFailed tolerates the held row
    expect(await row(pub.id)).toMatchObject({
      state: 'held',
      holdReasons: [EXPORT_HASH_MISMATCH],
      stateReason: EXPORT_HASH_MISMATCH,
    });
    const attempts = await attemptsOf(pub.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'rejected', errorCode: EXPORT_HASH_MISMATCH, sentAt: null });
    expect(fixture.posts).toHaveLength(postsBefore); // never reached the platform
    expect(releaseKeys()).toHaveLength(releasesBefore); // nothing minted
    expect(await auditOf('asset.release_minted')).toHaveLength(mintedBefore);
    const holds = (await auditOf('publication.hold')).filter((a) => a.resourceId === pub.id);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.metadata).toMatchObject({ reason: EXPORT_HASH_MISMATCH, toState: 'held' });
  });
});
