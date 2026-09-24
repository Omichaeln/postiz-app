import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import type { AssetIngestInputV1, IngestSanitiseResult, IngestStepResult } from '@oremedia/contracts/assets';
import {
  NotFoundError,
  PolicyDeniedError,
  RightsIneligibleError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import {
  assetDerivatives,
  assetVersions,
  assets,
  uploadIntents,
  usageRights,
} from '@oremedia/db/schema/assets';
import { outboxEvents } from '@oremedia/db/schema/operations';
import { sha256Hex } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { assetIngest, type IngestDeps } from './ingest/pipeline';
import { FakeScanner } from './ingest/scanner';
import { assetService } from './service';
import { MemoryStorageProvider, configureStorage, storageKeys } from './storage';

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const svgWithScript = `<svg ${SVG_NS} width="100" height="100"><script>alert(1)</script><rect width="100" height="100"/></svg>`;
const png = () =>
  sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 10, g: 200, b: 20, alpha: 1 } } })
    .png()
    .toBuffer();

const actor = (
  tenantId: string,
  id: string,
  role: 'owner' | 'creator',
  brandIds: string[] | 'all',
): ResolvedActor => ({
  kind: 'user',
  id,
  tenantId,
  membershipId: `mem_${id}`,
  membershipStatus: 'active',
  role,
  allBrands: brandIds === 'all',
  brandGrants: brandIds === 'all' ? [] : brandIds.map((brandId) => ({ brandId, roles: [] })),
  mfaEnrolled: false,
});
const ctxFor = (a: ResolvedActor): TenantContext => ({
  tenantId: a.tenantId,
  actor: { kind: a.kind, id: a.id },
  brandIds: a.kind === 'user' && !a.allBrands ? new Set(a.brandGrants.map((g) => g.brandId)) : 'all',
  correlationId: `corr_${a.id}`,
});
const hours = (n: number) => new Date(Date.now() + n * 3600_000);

describe('assets module against MySQL 8 (spec 9)', () => {
  let tdb: TestDatabase;
  const mem = new MemoryStorageProvider();
  const deps: IngestDeps = { storage: mem, scanner: new FakeScanner() };
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA1 = newId('brand');
  const brandA2 = newId('brand');
  const brandB1 = newId('brand');
  const ownerA = actor(tenantA, newId('user'), 'owner', 'all');
  const creatorA1 = actor(tenantA, newId('user'), 'creator', [brandA1]);
  const ownerB = actor(tenantB, newId('user'), 'owner', 'all');

  /** Direct seed of an approved (or otherwise) asset with one version and optional rights. */
  async function seedAsset(opts: {
    brandId: string;
    kind?: 'photo' | 'font' | 'logo';
    state?: 'approved' | 'pending_review' | 'retired';
    rights?: null | { expiresAt?: Date | null; channels?: 'all' | string[]; territories?: 'all' | string[] };
    tenantId?: string;
    name?: string;
  }) {
    const tenantId = opts.tenantId ?? tenantA;
    const id = newId('asset');
    const versionId = newId('assetVersion');
    await tdb.db.insert(assets).values({
      id,
      tenantId,
      brandId: opts.brandId,
      kind: opts.kind ?? 'photo',
      name: opts.name ?? `asset ${id}`,
      currentVersionId: versionId,
      state: opts.state ?? 'approved',
      rightsState: opts.rights === null ? 'unknown' : 'recorded',
    });
    await tdb.db.insert(assetVersions).values({
      id: versionId,
      tenantId,
      brandId: opts.brandId,
      assetId: id,
      number: 1,
      storageKey: storageKeys.original(tenantId, opts.brandId, id, versionId),
      contentHash: sha256Hex(id),
      mime: opts.kind === 'font' ? 'font/ttf' : 'image/png',
      bytes: 100,
      width: 64,
      height: 48,
      provenance: { kind: 'upload', uploadedByUserId: ownerA.id, originalFilename: 'seed.png' },
    });
    if (opts.rights !== null)
      await tdb.db.insert(usageRights).values({
        id: newId('usageRights'),
        tenantId,
        brandId: opts.brandId,
        assetId: id,
        owner: 'owner',
        permittedChannels: opts.rights?.channels ?? 'all',
        territories: opts.rights?.territories ?? 'all',
        expiresAt: opts.rights?.expiresAt ?? null,
        releases: [],
        restrictions: [],
      });
    return { id, versionId };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureStorage(mem);
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: `assets-a-${tenantA.slice(-6).toLowerCase()}` },
      { id: tenantB, name: 'B', slug: `assets-b-${tenantB.slice(-6).toLowerCase()}` },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA1, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB1, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  /** Runs the pipeline exactly as the workflow does (packages/workflows asset-ingest.workflow.v1). */
  async function runPipeline(input: AssetIngestInputV1, autoApprove: boolean) {
    const begin = await assetIngest.begin(input);
    const cleanupKeys = [begin.storageKey];
    const finish = async (
      reason: string,
      outcome: 'rejected' | 'quarantined',
      duplicateOfAssetId?: string,
    ) => {
      await assetIngest.finalise(deps, {
        ...input,
        outcome,
        reason: reason as never,
        duplicateOfAssetId,
        cleanupKeys,
      });
      return { outcome, reason, duplicateOfAssetId };
    };
    const verified = await assetIngest.verify(deps, input);
    if (!verified.ok) return finish(verified.reason, 'rejected');
    const sniffed = await assetIngest.sniff(deps, input);
    if (!sniffed.ok) return finish(sniffed.reason, 'rejected');
    const scanned = await assetIngest.scan(deps, input);
    if (!scanned.ok) return finish(scanned.reason, scanned.retryable ? 'quarantined' : 'rejected');
    const sanitised: IngestStepResult<IngestSanitiseResult> = await assetIngest.sanitise(deps, {
      ...input,
      ...sniffed,
    });
    if (!sanitised.ok) return finish(sanitised.reason, 'rejected');
    cleanupKeys.push(sanitised.sanitisedKey);
    if (sanitised.previewKey) cleanupKeys.push(sanitised.previewKey);
    const hashed = await assetIngest.hash(deps, { ...input, sanitisedKey: sanitised.sanitisedKey });
    if (!hashed.ok) return finish(hashed.reason, 'rejected', hashed.duplicateOfAssetId);
    const built = await assetIngest.derivatives(deps, {
      ...input,
      sanitisedKey: sanitised.sanitisedKey,
      mime: sanitised.mime,
      group: sniffed.group,
      previewKey: sanitised.previewKey,
    });
    if (!built.ok) return finish(built.reason, 'rejected');
    cleanupKeys.push(...built.derivatives.map((d) => d.key));
    const moved = await assetIngest.move(deps, {
      ...input,
      sanitisedKey: sanitised.sanitisedKey,
      derivatives: built.derivatives,
    });
    const catalogued = await assetIngest.catalogue({
      ...input,
      ...moved,
      contentHash: hashed.contentHash,
      mime: sanitised.mime,
      bytes: sanitised.bytes,
      width: sanitised.width,
      height: sanitised.height,
      colourProfile: sanitised.colourProfile,
      fontMetadata: sanitised.fontMetadata,
      sanitised: sanitised.sanitised,
      autoApprove,
    });
    await assetIngest.finalise(deps, { ...input, outcome: 'accepted', cleanupKeys });
    return { outcome: 'accepted' as const, ...catalogued };
  }

  async function uploadAs(
    a: ResolvedActor,
    brandId: string,
    kind: 'photo' | 'logo',
    mime: string,
    bytes: Buffer,
    name: string,
  ) {
    return runInTenant(ctxFor(a), async () => {
      const intent = await withTransaction((tx) =>
        assetService.createIntent(
          a,
          { brandId, kind, declaredMime: mime, declaredBytes: bytes.length, originalFilename: name },
          tx,
        ),
      );
      expect(intent.uploadUrl).toContain(storageKeys.quarantine(a.tenantId, intent.intentId));
      await mem.putObject(storageKeys.quarantine(a.tenantId, intent.intentId), bytes, { contentType: mime });
      const completed = await withTransaction((tx) =>
        assetService.completeUpload(a, { intentId: intent.intentId }, tx),
      );
      expect(completed.state).toBe('uploaded');
      return intent.intentId;
    });
  }

  describe('ingestion pipeline (spec 9.1)', () => {
    it('a valid PNG travels intent → quarantine → sanitised original, derivatives and catalogue rows', async () => {
      const intentId = await uploadAs(ownerA, brandA1, 'photo', 'image/png', await png(), 'hero.png');
      const outboxRows = await tdb.db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, intentId));
      expect(outboxRows.map((r) => r.eventType)).toEqual(['asset.upload_completed']);
      const input: AssetIngestInputV1 = {
        tenantId: tenantA,
        actor: { kind: 'user', id: ownerA.id },
        correlationId: 'corr_ingest',
        intentId,
        brandId: brandA1,
      };
      const result = await runInTenant(ctxFor(ownerA), () => runPipeline(input, true));
      expect(result.outcome).toBe('accepted');
      if (result.outcome !== 'accepted') return;
      const [asset] = await tdb.db.select().from(assets).where(eq(assets.id, result.assetId));
      expect(asset).toMatchObject({
        tenantId: tenantA,
        brandId: brandA1,
        state: 'approved',
        rightsState: 'unknown',
        currentVersionId: result.assetVersionId,
        name: 'hero.png',
      });
      const [version] = await tdb.db
        .select()
        .from(assetVersions)
        .where(eq(assetVersions.id, result.assetVersionId));
      expect(version).toMatchObject({ mime: 'image/png', width: 64, height: 48, number: 1 });
      expect(version?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(version?.provenance).toMatchObject({
        kind: 'upload',
        uploadedByUserId: ownerA.id,
        sanitised: true,
      });
      const derivs = await tdb.db
        .select()
        .from(assetDerivatives)
        .where(eq(assetDerivatives.assetVersionId, result.assetVersionId));
      expect(derivs.map((d) => d.purpose).sort()).toEqual(['preview', 'thumbnail', 'web']);
      const [intent] = await tdb.db.select().from(uploadIntents).where(eq(uploadIntents.id, intentId));
      expect(intent).toMatchObject({ state: 'accepted', resultAssetId: result.assetId });
      // Storage: immutable keys exist, quarantine is empty.
      expect(mem.has(storageKeys.original(tenantA, brandA1, result.assetId, result.assetVersionId))).toBe(
        true,
      );
      expect(mem.keys().filter((k) => k.startsWith(`quarantine/${tenantA}/${intentId}`))).toEqual([]);
      const events = await tdb.db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, result.assetId));
      expect(events.map((e) => e.eventType)).toEqual(['asset.ingested']);
      // The library reads it back and mints a 5-minute signed URL for a derivative.
      await runInTenant(ctxFor(ownerA), async () => {
        const got = await assetService.get(ownerA, { assetId: result.assetId });
        expect(got.derivatives.length).toBe(3);
        const signed = await assetService.signedUrl(ownerA, {
          assetVersionId: result.assetVersionId,
          derivative: 'preview',
        });
        expect(signed.url).toContain(
          `assets/${tenantA}/${brandA1}/${result.assetId}/${result.assetVersionId}/preview`,
        );
        expect(signed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300_000);
        expect(signed.expiresAt.getTime() - Date.now()).toBeGreaterThan(290_000);
      });
    });

    it('a creator without asset.approve gets pending_review; an SVG with a script is rejected and cleaned up', async () => {
      const okIntent = await uploadAs(
        creatorA1,
        brandA1,
        'photo',
        'image/png',
        await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } })
          .png()
          .toBuffer(),
        'small.png',
      );
      const okResult = await runInTenant(ctxFor(creatorA1), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: creatorA1.id },
            correlationId: 'c',
            intentId: okIntent,
            brandId: brandA1,
          },
          false,
        ),
      );
      expect(okResult).toMatchObject({ outcome: 'accepted', state: 'pending_review' });

      const badIntent = await uploadAs(
        ownerA,
        brandA1,
        'logo',
        'image/svg+xml',
        Buffer.from(svgWithScript),
        'evil.svg',
      );
      const bad = await runInTenant(ctxFor(ownerA), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: ownerA.id },
            correlationId: 'c',
            intentId: badIntent,
            brandId: brandA1,
          },
          true,
        ),
      );
      expect(bad).toMatchObject({ outcome: 'rejected', reason: 'svg_unsafe_content' });
      const [intent] = await tdb.db.select().from(uploadIntents).where(eq(uploadIntents.id, badIntent));
      expect(intent).toMatchObject({
        state: 'rejected',
        rejectionReason: 'svg_unsafe_content',
        resultAssetId: null,
      });
      expect(mem.keys().filter((k) => k.includes(badIntent))).toEqual([]);
      expect((await tdb.db.select().from(assets).where(eq(assets.name, 'evil.svg'))).length).toBe(0);
    });

    it('identical content in the same brand is a duplicate_of proposal, not a second asset', async () => {
      const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#abcdef' } })
        .png()
        .toBuffer();
      const first = await uploadAs(ownerA, brandA2, 'photo', 'image/png', bytes, 'dup.png');
      const r1 = await runInTenant(ctxFor(ownerA), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: ownerA.id },
            correlationId: 'c',
            intentId: first,
            brandId: brandA2,
          },
          true,
        ),
      );
      expect(r1.outcome).toBe('accepted');
      const second = await uploadAs(ownerA, brandA2, 'photo', 'image/png', bytes, 'dup-again.png');
      const r2 = await runInTenant(ctxFor(ownerA), () =>
        runPipeline(
          {
            tenantId: tenantA,
            actor: { kind: 'user', id: ownerA.id },
            correlationId: 'c',
            intentId: second,
            brandId: brandA2,
          },
          true,
        ),
      );
      expect(r2).toMatchObject({
        outcome: 'rejected',
        reason: 'duplicate_of',
        duplicateOfAssetId: (r1 as { assetId: string }).assetId,
      });
      const [intent] = await tdb.db.select().from(uploadIntents).where(eq(uploadIntents.id, second));
      expect(intent).toMatchObject({
        state: 'rejected',
        rejectionReason: 'duplicate_of',
        resultAssetId: (r1 as { assetId: string }).assetId,
      });
    });

    it('createIntent enforces kind/mime/cap, refuses archives, and foreign brands are NOT_FOUND', async () => {
      await runInTenant(ctxFor(ownerA), async () => {
        const bad = (input: Record<string, unknown>) =>
          withTransaction((tx) => assetService.createIntent(ownerA, input as never, tx));
        await expect(
          bad({
            brandId: brandA1,
            kind: 'photo',
            declaredMime: 'application/zip',
            declaredBytes: 10,
            originalFilename: 'a.zip',
          }),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        await expect(
          bad({
            brandId: brandA1,
            kind: 'font',
            declaredMime: 'image/png',
            declaredBytes: 10,
            originalFilename: 'a.png',
          }),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        await expect(
          bad({
            brandId: brandA1,
            kind: 'logo',
            declaredMime: 'image/svg+xml',
            declaredBytes: 3 * 1024 * 1024,
            originalFilename: 'a.svg',
          }),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        await expect(
          bad({
            brandId: brandA1,
            kind: 'video',
            declaredMime: 'video/mp4',
            declaredBytes: 10,
            originalFilename: 'a.mp4',
          }),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        await expect(
          bad({
            brandId: brandB1,
            kind: 'photo',
            declaredMime: 'image/png',
            declaredBytes: 10,
            originalFilename: 'a.png',
          }),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
      await runInTenant(ctxFor(creatorA1), async () => {
        await expect(
          withTransaction((tx) =>
            assetService.createIntent(
              creatorA1,
              {
                brandId: brandA2,
                kind: 'photo',
                declaredMime: 'image/png',
                declaredBytes: 10,
                originalFilename: 'a.png',
              },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
    });
  });

  describe('eligibility (spec 9.2): ineligible assets never appear in search', () => {
    let eligible: { id: string; versionId: string };
    let pending: { id: string; versionId: string };
    let expired: { id: string; versionId: string };
    let font: { id: string; versionId: string };
    let otherBrand: { id: string; versionId: string };
    let unknownRights: { id: string; versionId: string };
    let channelBound: { id: string; versionId: string };
    let expiringLater: { id: string; versionId: string };
    const brandE = newId('brand');
    const brandF = newId('brand');

    beforeAll(async () => {
      await tdb.db.insert(brands).values([
        { id: brandE, tenantId: tenantA, name: 'E', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
        { id: brandF, tenantId: tenantA, name: 'F', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      ]);
      eligible = await seedAsset({ brandId: brandE, name: 'eligible' });
      pending = await seedAsset({ brandId: brandE, state: 'pending_review' });
      expired = await seedAsset({ brandId: brandE, rights: { expiresAt: hours(1) } });
      font = await seedAsset({ brandId: brandE, kind: 'font' });
      otherBrand = await seedAsset({ brandId: brandF });
      unknownRights = await seedAsset({ brandId: brandE, rights: null });
      channelBound = await seedAsset({
        brandId: brandE,
        rights: { channels: ['cc_1'], territories: ['GB'] },
      });
      expiringLater = await seedAsset({ brandId: brandE, rights: { expiresAt: hours(48) } });
      await seedAsset({ brandId: brandB1, tenantId: tenantB, name: 'eligible' });
    });

    const searchIds = (a: ResolvedActor, query: Record<string, unknown>) =>
      runInTenant(ctxFor(a), async () =>
        (await assetService.search(a, { query: query as never, page: { limit: 50 } })).items
          .map((i) => i.assetId)
          .sort(),
      );

    it('returns only approved, in-brand, rights-bearing, kind-compatible assets', async () => {
      const ids = await searchIds(ownerA, { brandId: brandE, purpose: 'creative' });
      expect(ids).toEqual([eligible.id, channelBound.id, expiringLater.id].sort());
      for (const excluded of [pending, expired, font, otherBrand, unknownRights])
        expect(ids).not.toContain(excluded.id);
    });
    it('font purpose returns the font; reference purpose returns unknown-rights assets too, never pending ones', async () => {
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'font' })).toEqual([font.id]);
      const ref = await searchIds(ownerA, { brandId: brandE, purpose: 'reference' });
      expect(ref).toContain(unknownRights.id);
      expect(ref).toContain(font.id);
      expect(ref).not.toContain(pending.id);
      expect(ref).not.toContain(expired.id);
    });
    it('channels, territory and scheduledFor narrow the result', async () => {
      expect(
        await searchIds(ownerA, { brandId: brandE, purpose: 'creative', channelConnectionIds: ['cc_2'] }),
      ).toEqual([eligible.id, expiringLater.id].sort());
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'creative', territory: 'US' })).toEqual(
        [eligible.id, expiringLater.id].sort(),
      );
      expect(
        await searchIds(ownerA, {
          brandId: brandE,
          purpose: 'creative',
          territory: 'GB',
          channelConnectionIds: ['cc_1'],
        }),
      ).toEqual([eligible.id, channelBound.id, expiringLater.id].sort());
      expect(
        await searchIds(ownerA, {
          brandId: brandE,
          purpose: 'creative',
          scheduledFor: hours(20).toISOString(),
        }),
      ).toEqual([eligible.id, channelBound.id, expiringLater.id].sort());
      // 48h rights, scheduled at +30h: the 24h processing window pushes past expiry → held out.
      expect(
        await searchIds(ownerA, {
          brandId: brandE,
          purpose: 'creative',
          scheduledFor: hours(30).toISOString(),
        }),
      ).toEqual([eligible.id, channelBound.id].sort());
    });
    it('another brand’s asset appears only through an active grant for that purpose', async () => {
      await runInTenant(ctxFor(ownerA), () =>
        withTransaction((tx) =>
          assetService.createGrant(
            ownerA,
            { assetId: otherBrand.id, granteeBrandId: brandE, purpose: 'creative' },
            tx,
          ),
        ),
      );
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'creative' })).toContain(otherBrand.id);
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'reference' })).not.toContain(otherBrand.id);
      const expiredGrant = await seedAsset({ brandId: brandF });
      await runInTenant(ctxFor(ownerA), () =>
        withTransaction((tx) =>
          assetService.createGrant(
            ownerA,
            {
              assetId: expiredGrant.id,
              granteeBrandId: brandE,
              purpose: 'creative',
              expiresAt: new Date(Date.now() - 1000).toISOString(),
            },
            tx,
          ),
        ),
      );
      expect(await searchIds(ownerA, { brandId: brandE, purpose: 'creative' })).not.toContain(
        expiredGrant.id,
      );
    });
    it('brand visibility and tenancy: a restricted creator and a foreign tenant get NOT_FOUND', async () => {
      await expect(searchIds(creatorA1, { brandId: brandE, purpose: 'creative' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(searchIds(ownerB, { brandId: brandE, purpose: 'creative' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await runInTenant(ctxFor(ownerB), async () => {
        await expect(assetService.get(ownerB, { assetId: eligible.id })).rejects.toBeInstanceOf(
          NotFoundError,
        );
        await expect(
          assetService.authoriseUse(eligible.versionId, 'creative', { brandId: brandB1 }),
        ).rejects.toBeInstanceOf(NotFoundError);
      });
    });
    it('authoriseUse re-runs the rule and throws RIGHTS_INELIGIBLE with the reason', async () => {
      await runInTenant(ctxFor(ownerA), async () => {
        const ok = await assetService.authoriseUse(eligible.versionId, 'creative', { brandId: brandE });
        expect(ok).toMatchObject({
          assetId: eligible.id,
          assetVersionId: eligible.versionId,
          brandId: brandE,
        });
        const reason = async (
          versionId: string,
          purpose: 'creative' | 'reference' | 'logo',
          opts: Record<string, unknown> = {},
        ) => {
          try {
            await assetService.authoriseUse(versionId, purpose, { brandId: brandE, ...opts });
            return 'eligible';
          } catch (err) {
            expect(err).toBeInstanceOf(RightsIneligibleError);
            return (err as RightsIneligibleError).details?.[0]?.issue;
          }
        };
        expect(await reason(pending.versionId, 'creative')).toBe('state_not_approved');
        expect(await reason(expired.versionId, 'creative')).toBe('rights_expired');
        expect(await reason(unknownRights.versionId, 'creative')).toBe('rights_unknown');
        expect(await reason(unknownRights.versionId, 'reference')).toBe('eligible');
        expect(await reason(font.versionId, 'creative')).toBe('kind_incompatible');
        expect(await reason(channelBound.versionId, 'creative', { channelConnectionIds: ['cc_9'] })).toBe(
          'channel_not_permitted',
        );
        expect(await reason(channelBound.versionId, 'creative', { territory: 'FR' })).toBe(
          'territory_not_permitted',
        );
        expect(await reason(expiringLater.versionId, 'creative', { scheduledFor: hours(30) })).toBe(
          'rights_expired',
        );
        expect(await reason(otherBrand.versionId, 'creative')).toBe('eligible'); // granted above
        expect(await reason(otherBrand.versionId, 'reference')).toBe('brand_not_permitted');
      });
    });
  });

  describe('grants, rights, approval and delivery', () => {
    it('a grant can only target a brand of the same tenant, never the owner brand or a foreign one', async () => {
      const a = await seedAsset({ brandId: brandA1 });
      await runInTenant(ctxFor(ownerA), async () => {
        await expect(
          withTransaction((tx) =>
            assetService.createGrant(
              ownerA,
              { assetId: a.id, granteeBrandId: brandB1, purpose: 'creative' },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          withTransaction((tx) =>
            assetService.createGrant(
              ownerA,
              { assetId: a.id, granteeBrandId: brandA1, purpose: 'creative' },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        const g = await withTransaction((tx) =>
          assetService.createGrant(ownerA, { assetId: a.id, granteeBrandId: brandA2, purpose: 'logo' }, tx),
        );
        expect(g.grantId).toMatch(/^ag_/);
        await expect(
          withTransaction((tx) =>
            assetService.createGrant(ownerA, { assetId: a.id, granteeBrandId: brandA2, purpose: 'logo' }, tx),
          ),
        ).rejects.toBeInstanceOf(ValidationFailedError);
      });
      await runInTenant(ctxFor(creatorA1), async () => {
        await expect(
          withTransaction((tx) =>
            assetService.createGrant(
              creatorA1,
              { assetId: a.id, granteeBrandId: brandA2, purpose: 'logo' },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(PolicyDeniedError);
      });
    });
    it('rights.set records rights; approve/retire follow the state machine and roles', async () => {
      const p = await seedAsset({ brandId: brandA1, state: 'pending_review', rights: null });
      await runInTenant(ctxFor(creatorA1), async () => {
        await expect(
          withTransaction((tx) => assetService.approve(creatorA1, { assetId: p.id, expectedVersion: 0 }, tx)),
        ).rejects.toBeInstanceOf(PolicyDeniedError);
      });
      await runInTenant(ctxFor(ownerA), async () => {
        await withTransaction((tx) =>
          assetService.setRights(
            ownerA,
            {
              assetId: p.id,
              owner: 'Studio',
              permittedChannels: 'all',
              territories: 'all',
              releases: [],
              restrictions: [],
            },
            tx,
          ),
        );
        let got = await assetService.get(ownerA, { assetId: p.id });
        expect(got.rightsState).toBe('recorded');
        expect(got.rights?.owner).toBe('Studio');
        // Upsert: a second call updates the same row.
        await withTransaction((tx) =>
          assetService.setRights(
            ownerA,
            {
              assetId: p.id,
              owner: 'Studio 2',
              permittedChannels: ['cc_1'],
              territories: 'all',
              releases: [],
              restrictions: [],
            },
            tx,
          ),
        );
        got = await assetService.get(ownerA, { assetId: p.id });
        expect(got.rights?.owner).toBe('Studio 2');
        expect((await tdb.db.select().from(usageRights).where(eq(usageRights.assetId, p.id))).length).toBe(1);
        const approved = await withTransaction((tx) =>
          assetService.approve(ownerA, { assetId: p.id, expectedVersion: got.version }, tx),
        );
        expect(approved.state).toBe('approved');
        await expect(
          withTransaction((tx) =>
            assetService.approve(ownerA, { assetId: p.id, expectedVersion: approved.version }, tx),
          ),
        ).rejects.toBeInstanceOf(ValidationFailedError);
        const retired = await withTransaction((tx) =>
          assetService.retire(
            ownerA,
            { assetId: p.id, expectedVersion: approved.version, reason: 'superseded' },
            tx,
          ),
        );
        expect(retired.state).toBe('retired');
        const events = await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, p.id));
        expect(events.map((e) => e.eventType)).toEqual(['asset.retired']);
        expect(
          (
            await assetService.search(ownerA, {
              query: { brandId: brandA1, purpose: 'creative', channelConnectionIds: [] },
              page: { limit: 50 },
            })
          ).items.map((i) => i.assetId),
        ).not.toContain(p.id);
      });
    });
    it('releaseDerivative copies to releases/ with a URL covering the provider window and records the release', async () => {
      const a = await seedAsset({ brandId: brandA1 });
      await runInTenant(ctxFor(ownerA), async () => {
        await mem.putObject(
          storageKeys.original(tenantA, brandA1, a.id, a.versionId),
          Buffer.from('original-bytes'),
          { contentType: 'image/png' },
        );
        const rel = await withTransaction((tx) =>
          assetService.releaseDerivative(a.versionId, 24 * 3600, {}, tx),
        );
        expect(rel.storageKey).toMatch(
          new RegExp(`^releases/${tenantA}/${brandA1}/${a.versionId}/original/ad_`),
        );
        expect(mem.has(rel.storageKey)).toBe(true);
        expect(rel.expiresAt.getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
        const rows = await tdb.db
          .select()
          .from(assetDerivatives)
          .where(eq(assetDerivatives.assetVersionId, a.versionId));
        expect(rows.map((r) => r.purpose)).toEqual(['release']);
        await withTransaction((tx) => assetService.recordUsage(a.versionId, 'publication', 'pub_1', tx));
        const usages = await assetService.listUsages(ownerA, { assetId: a.id, page: { limit: 10 } });
        expect(usages.items).toMatchObject([{ usedByType: 'publication', usedById: 'pub_1' }]);
      });
    });
  });

  describe('cursor pagination bounds (spec 7.4)', () => {
    it('pages through eligible assets with an opaque cursor and rejects out-of-range limits', async () => {
      const brandP = newId('brand');
      await tdb.db.insert(brands).values({
        id: brandP,
        tenantId: tenantA,
        name: 'P',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'active',
      });
      const seeded = new Set<string>();
      for (let i = 0; i < 5; i++) seeded.add((await seedAsset({ brandId: brandP })).id);
      await runInTenant(ctxFor(ownerA), async () => {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await assetService.search(ownerA, {
            query: { brandId: brandP, purpose: 'creative', channelConnectionIds: [] },
            page: { limit: 2, cursor },
          });
          expect(page.items.length).toBeLessThanOrEqual(2);
          seen.push(...page.items.map((i) => i.assetId));
          cursor = page.nextCursor ?? undefined;
          pages++;
        } while (cursor);
        expect(pages).toBe(3);
        expect(new Set(seen)).toEqual(seeded);
        expect(seen.length).toBe(5);
        await expect(
          assetService.search(ownerA, {
            query: { brandId: brandP, purpose: 'creative', channelConnectionIds: [] },
            page: { limit: 500 },
          }),
        ).rejects.toThrow();
        await expect(
          assetService.search(ownerA, {
            query: { brandId: brandP, purpose: 'creative', channelConnectionIds: [] },
            page: { limit: 0 },
          }),
        ).rejects.toThrow();
        const garbage = await assetService.search(ownerA, {
          query: { brandId: brandP, purpose: 'creative', channelConnectionIds: [] },
          page: { limit: 10, cursor: 'not-a-cursor' },
        });
        expect(garbage.items.length).toBe(5);
      });
    });
  });
});
