import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { deflateSync } from 'node:zlib';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { AssetIngestInputV1 } from '@oremedia/contracts/assets';
import { NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { brandGrants, memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { newId } from '@oremedia/domain/ids';
import {
  FakeScanner,
  MemoryStorageProvider,
  ScannerUnavailableError,
  assetService,
  configureStorage,
  storageKeys,
  type Scanner,
} from '@oremedia/module-assets';
import { createAssetIngestActivities } from './asset-ingest';

/** A minimal valid 8×8 RGB PNG built here so this package needs no image library; `seed` varies the bytes (dedupe). */
function tinyPng(seed = 0): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let crc = ~0;
    for (const b of buf) crc = (crcTable[(crc ^ b) & 0xff] as number) ^ (crc >>> 8);
    return ~crc >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0);
  ihdr.writeUInt32BE(8, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < 8; y++)
    rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(8 * 3, (0x40 + y + seed) & 0xff)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Spec 19.3 for workflow activities: an activity invoked with a mismatched tenantId or resource ids must fail
 * with NOT_FOUND, and the actor's grants are re-loaded at the point of effect (spec 5.2). MockActivityEnvironment
 * runs activities with a real activity Context and needs no Temporal server.
 */
describe('asset ingest activities (MockActivityEnvironment against MySQL)', () => {
  let tdb: TestDatabase;
  const mem = new MemoryStorageProvider();
  const env = new MockActivityEnvironment();
  const run = <A, R>(fn: (arg: A) => Promise<R>, arg: A): Promise<R> => env.run(fn, arg) as Promise<R>;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA1 = newId('brand');
  const brandA2 = newId('brand');
  const brandB1 = newId('brand');
  const ownerA = newId('user');
  const creatorA = newId('user');
  const ownerB = newId('user');
  const creatorMembership = newId('membership');

  const actorFor = (
    userId: string,
    tenantId: string,
    role: 'owner' | 'creator',
    brand?: string,
  ): ResolvedActor => ({
    kind: 'user',
    id: userId,
    tenantId,
    membershipId: `mem_${userId}`,
    membershipStatus: 'active',
    role,
    allBrands: !brand,
    brandGrants: brand ? [{ brandId: brand, roles: [] }] : [],
    mfaEnrolled: false,
  });
  const ctxFor = (a: ResolvedActor): TenantContext => ({
    tenantId: a.tenantId,
    actor: { kind: 'user', id: a.id },
    brandIds: a.kind === 'user' && !a.allBrands ? new Set(a.brandGrants.map((g) => g.brandId)) : 'all',
    correlationId: 'corr_act',
  });
  const inputFor = (
    userId: string,
    tenantId: string,
    intentId: string,
    brandId: string,
  ): AssetIngestInputV1 => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    correlationId: 'corr_act',
    intentId,
    brandId,
  });

  let uploads = 0;
  async function issueAndUpload(actor: ResolvedActor, brandId: string): Promise<string> {
    const bytes = tinyPng(++uploads);
    return runInTenant(ctxFor(actor), async () => {
      const intent = await withTransaction((tx) =>
        assetService.createIntent(
          actor,
          {
            brandId,
            kind: 'photo',
            declaredMime: 'image/png',
            declaredBytes: bytes.length,
            originalFilename: `${newId('asset')}.png`,
          },
          tx,
        ),
      );
      await mem.putObject(storageKeys.quarantine(actor.tenantId, intent.intentId), bytes, {
        contentType: 'image/png',
      });
      await withTransaction((tx) => assetService.completeUpload(actor, { intentId: intent.intentId }, tx));
      return intent.intentId;
    });
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureStorage(mem);
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: `act-a-${tenantA.slice(-6).toLowerCase()}` },
      { id: tenantB, name: 'B', slug: `act-b-${tenantB.slice(-6).toLowerCase()}` },
    ]);
    await tdb.db.insert(users).values([
      { id: ownerA, email: `${ownerA.toLowerCase()}@example.test`, name: 'owner a' },
      { id: creatorA, email: `${creatorA.toLowerCase()}@example.test`, name: 'creator a' },
      { id: ownerB, email: `${ownerB.toLowerCase()}@example.test`, name: 'owner b' },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA1, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB1, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    await tdb.db.insert(memberships).values([
      {
        id: newId('membership'),
        tenantId: tenantA,
        userId: ownerA,
        role: 'owner',
        status: 'active',
        allBrands: true,
      },
      {
        id: creatorMembership,
        tenantId: tenantA,
        userId: creatorA,
        role: 'creator',
        status: 'active',
        allBrands: false,
      },
      {
        id: newId('membership'),
        tenantId: tenantB,
        userId: ownerB,
        role: 'owner',
        status: 'active',
        allBrands: true,
      },
    ]);
    await tdb.db.insert(brandGrants).values({
      id: newId('brandGrant'),
      tenantId: tenantA,
      membershipId: creatorMembership,
      brandId: brandA1,
      roles: [],
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('runs every activity for an owner and catalogues the asset as approved (uploader holds asset.approve)', async () => {
    const acts = createAssetIngestActivities({ storage: mem, scanner: new FakeScanner() });
    const intentId = await issueAndUpload(actorFor(ownerA, tenantA, 'owner'), brandA1);
    const input = inputFor(ownerA, tenantA, intentId, brandA1);
    const begin = await run(acts.beginIngest, input);
    expect(begin).toMatchObject({ intentId, brandId: brandA1, kind: 'photo' });
    expect(await run(acts.verifyUpload, input)).toMatchObject({ ok: true });
    const sniffed = await run(acts.sniffUpload, input);
    expect(sniffed).toEqual({ ok: true, mime: 'image/png', group: 'image' });
    expect(await run(acts.scanUpload, input)).toEqual({ ok: true, engine: 'fake' });
    const sanitised = await run(acts.sanitiseUpload, {
      ...input,
      mime: 'image/png',
      group: 'image' as const,
    });
    expect(sanitised.ok).toBe(true);
    if (!sanitised.ok) return;
    const hashed = await run(acts.hashUpload, { ...input, sanitisedKey: sanitised.sanitisedKey });
    expect(hashed.ok).toBe(true);
    if (!hashed.ok) return;
    const built = await run(acts.buildDerivatives, {
      ...input,
      sanitisedKey: sanitised.sanitisedKey,
      mime: sanitised.mime,
      group: 'image' as const,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const moved = await run(acts.moveToImmutable, {
      ...input,
      sanitisedKey: sanitised.sanitisedKey,
      derivatives: built.derivatives,
    });
    const catalogued = await run(acts.catalogueAsset, {
      ...input,
      ...moved,
      contentHash: hashed.contentHash,
      mime: sanitised.mime,
      bytes: sanitised.bytes,
      width: sanitised.width,
      height: sanitised.height,
      colourProfile: sanitised.colourProfile,
      sanitised: sanitised.sanitised,
    });
    expect(catalogued).toMatchObject({ assetId: moved.assetId, state: 'approved' });
    await run(acts.finaliseUpload, {
      ...input,
      outcome: 'accepted' as const,
      cleanupKeys: [begin.storageKey, sanitised.sanitisedKey, ...built.derivatives.map((d) => d.key)],
    });
    expect(mem.keys().filter((k) => k.includes(intentId))).toEqual([]);
  });

  it('a creator without asset.approve gets pending_review, decided at catalogue time', async () => {
    const acts = createAssetIngestActivities({ storage: mem, scanner: new FakeScanner() });
    const creator = actorFor(creatorA, tenantA, 'creator', brandA1);
    const intentId = await issueAndUpload(creator, brandA1);
    const input = inputFor(creatorA, tenantA, intentId, brandA1);
    await run(acts.beginIngest, input);
    const sanitised = await run(acts.sanitiseUpload, {
      ...input,
      mime: 'image/png',
      group: 'image' as const,
    });
    if (!sanitised.ok) throw new Error('sanitise failed');
    const hashed = await run(acts.hashUpload, { ...input, sanitisedKey: sanitised.sanitisedKey });
    if (!hashed.ok) throw new Error('hash failed');
    const moved = await run(acts.moveToImmutable, {
      ...input,
      sanitisedKey: sanitised.sanitisedKey,
      derivatives: [],
    });
    const catalogued = await run(acts.catalogueAsset, {
      ...input,
      ...moved,
      contentHash: hashed.contentHash,
      mime: sanitised.mime,
      bytes: sanitised.bytes,
      width: sanitised.width,
      height: sanitised.height,
      colourProfile: sanitised.colourProfile,
      sanitised: sanitised.sanitised,
    });
    expect(catalogued.state).toBe('pending_review');
  });

  it('cross-tenant and cross-brand inputs are NOT_FOUND; a revoked brand grant is seen at the point of effect', async () => {
    const acts = createAssetIngestActivities({ storage: mem, scanner: new FakeScanner() });
    const creator = actorFor(creatorA, tenantA, 'creator', brandA1);
    const intentId = await issueAndUpload(creator, brandA1);
    // Tenant B's owner with tenant A's intent id.
    await expect(run(acts.beginIngest, inputFor(ownerB, tenantB, intentId, brandA1))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Right tenant, wrong brand carried by the workflow.
    await expect(
      run(acts.beginIngest, inputFor(creatorA, tenantA, intentId, brandA2)),
    ).rejects.toBeInstanceOf(NotFoundError);
    // The creator's grant to brand A1 is revoked after the upload: the activity re-loads grants and refuses.
    await tdb.db
      .delete(brandGrants)
      .where(and(eq(brandGrants.membershipId, creatorMembership), eq(brandGrants.brandId, brandA1)));
    await expect(
      run(acts.beginIngest, inputFor(creatorA, tenantA, intentId, brandA1)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await tdb.db.insert(brandGrants).values({
      id: newId('brandGrant'),
      tenantId: tenantA,
      membershipId: creatorMembership,
      brandId: brandA1,
      roles: [],
    });
    expect(await run(acts.beginIngest, inputFor(creatorA, tenantA, intentId, brandA1))).toMatchObject({
      intentId,
    });
    // A user who is not a member of the tenant at all.
    await expect(run(acts.verifyUpload, inputFor(ownerB, tenantA, intentId, brandA1))).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });

  it('an unreachable scanner throws ScannerUnavailableError (retried by Temporal; the intent stays quarantined)', async () => {
    const down: Scanner = {
      engine: 'down',
      scan: async () => {
        throw new ScannerUnavailableError('clamd unreachable');
      },
    };
    const acts = createAssetIngestActivities({ storage: mem, scanner: down });
    const intentId = await issueAndUpload(actorFor(ownerA, tenantA, 'owner'), brandA1);
    const input = inputFor(ownerA, tenantA, intentId, brandA1);
    await run(acts.beginIngest, input);
    await expect(run(acts.scanUpload, input)).rejects.toBeInstanceOf(ScannerUnavailableError);
    await run(acts.finaliseUpload, {
      ...input,
      outcome: 'quarantined' as const,
      reason: 'scanner_unavailable' as const,
      cleanupKeys: [],
    });
    const got = await runInTenant(ctxFor(actorFor(ownerA, tenantA, 'owner')), async () => {
      const { UploadIntentRepository } = await import('@oremedia/module-assets');
      return new UploadIntentRepository().getById(intentId);
    });
    expect(got).toMatchObject({ state: 'quarantined', rejectionReason: 'scanner_unavailable' });
  });

  it('finaliseUpload refuses to delete anything outside the intent’s quarantine prefix', async () => {
    const acts = createAssetIngestActivities({ storage: mem, scanner: new FakeScanner() });
    const intentId = await issueAndUpload(actorFor(ownerA, tenantA, 'owner'), brandA1);
    const input = inputFor(ownerA, tenantA, intentId, brandA1);
    await run(acts.beginIngest, input);
    await expect(
      run(acts.finaliseUpload, {
        ...input,
        outcome: 'rejected' as const,
        reason: 'type_mismatch' as const,
        cleanupKeys: [`assets/${tenantA}/${brandA1}/ast_x/av_x/original`],
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });
});
