import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Element } from '@oremedia/contracts/creative';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { RenderJobInputV1 } from '@oremedia/contracts/render';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { assetVersions, assets, usageRights } from '@oremedia/db/schema/assets';
import { brandVersions, brands } from '@oremedia/db/schema/brand';
import { renderJobs, renderedExports } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createRenderJobActivities } from '@oremedia/activities';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import { FIXTURE_FONTS } from '@oremedia/editor/renderer/fixtures';
import { MemoryStorageProvider, assetService, configureStorage, storageKeys } from '@oremedia/module-assets';
import { creativeService, registerAssetAuthoriser } from '@oremedia/module-creative';
import { runRenderJob } from '@oremedia/workflows/render-job.workflow.v1';
import { createChromiumRenderer } from './chromium-renderer';
import { creativeRenderJobStore } from './creative-store';
import { generateFixtureAsset, loadFixtureFont } from './fixture-assets';

/**
 * The render stream end to end against MySQL, the real creative/brand/asset modules and the real Chromium path:
 * creative.renders.request → renderJobWorkflowV1 orchestration (runRenderJob with the real activities) →
 * render_jobs pending → rendering → ready with rendered_exports whose content hash is the sha256 of the stored
 * bytes; the same revision rendered twice is byte-identical (the Phase 3 gate's precondition); an asset the
 * authoriser rejects at the point of effect fails the job with rights_ineligible and writes no export; illegal
 * state transitions are rejected by the module. Requires OREMEDIA_CHROMIUM_PATH and the renderer bundle.
 */
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const executablePath = process.env['OREMEDIA_CHROMIUM_PATH'];

/** Prefixed ids with a 26-character Crockford body (an app may not import the domain package's generator). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newId = (kind: IdKind): string =>
  `${ID_PREFIXES[kind]}_${[...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join('')}`;
const newElementId = () => newId('element');
const hashCanonical = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));

const ctx = (tenantId: string, userId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: userId },
  brandIds: 'all',
  correlationId: 'corr_render_e2e',
});
const manager = (tenantId: string, userId: string): ResolvedActor => ({
  kind: 'user',
  id: userId,
  tenantId,
  membershipId: `mem_${userId}`,
  membershipStatus: 'active',
  role: 'owner',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
      { key: 'accent', value: '#0F6E63', role: 'accent' },
    ],
    typeRoles: [
      { role: 'display', fontAssetId: 'ast_font', weight: 700, minSizePx: 40 },
      { role: 'heading', fontAssetId: 'ast_font', weight: 600, minSizePx: 28 },
      { role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 18 },
      { role: 'label', fontAssetId: 'ast_font', weight: 500, minSizePx: 14 },
      { role: 'caption', fontAssetId: 'ast_font', weight: 400, minSizePx: 12 },
    ],
    spacingScale: [4, 8, 16],
    radii: [0, 8],
    contrastTarget: 'AA',
  },
  logoRules: [
    {
      assetId: 'ast_logo',
      variant: 'primary',
      allowedBackgroundColourKeys: ['paper'],
      clearSpaceRatio: 0.5,
      minWidthPx: 120,
    },
  ],
});

const el = { bg: newElementId(), headline: newElementId(), photo: newElementId(), logo: newElementId() };

const studioDocument = (
  brandVersionId: string,
  refs: { font: string; photo: string; logo: string },
): CreativeDocumentV1 => ({
  schemaVersion: 1,
  brandVersionId,
  variants: [],
  pages: [
    {
      id: 'page_1',
      name: 'Feed',
      formatKey: 'square_1080',
      width: 1080,
      height: 1080,
      layoutConstraints: [
        { elementId: el.logo, anchor: 'bottom', marginPx: 60 },
        { elementId: el.headline, anchor: 'top', marginPx: 80 },
      ],
      elements: [
        {
          id: el.bg,
          name: 'Background',
          type: 'background',
          locked: true,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 0, y: 0, width: 1080, height: 1080, rotation: 0 },
          fillToken: 'paper',
        },
        {
          id: el.photo,
          name: 'Hero',
          type: 'image',
          locked: false,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 80, y: 260, width: 920, height: 460, rotation: 0 },
          assetVersionId: refs.photo,
          fit: 'cover',
          mask: { kind: 'rounded', radius: 24 },
        },
        {
          id: el.headline,
          name: 'Headline',
          type: 'text',
          locked: false,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 80, y: 80, width: 920, height: 150, rotation: 0 },
          text: 'October offer: twenty percent off',
          style: {
            typeRole: 'display',
            fontAssetVersionId: refs.font,
            weight: 700,
            sizePx: 60,
            lineHeight: 1.1,
            tracking: -0.01,
            colourToken: 'ink',
            align: 'left',
            overflow: 'error',
          },
          factRefs: [],
        } satisfies Element,
        {
          id: el.logo,
          name: 'Logo',
          type: 'logo',
          locked: false,
          visible: true,
          opacity: 1,
          protected: true,
          semanticRole: 'logo',
          transform: { x: 80, y: 960, width: 200, height: 60, rotation: 0 },
          assetVersionId: refs.logo,
          variant: 'primary',
        },
      ],
    },
  ],
});

describe('render job end to end (MySQL + creative module + Chromium)', () => {
  let tdb: TestDatabase;
  const mem = new MemoryStorageProvider();
  const tenantA = newId('tenant');
  const brandA = newId('brand');
  const ownerA = newId('user');
  const A = manager(tenantA, ownerA);
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx(tenantA, ownerA), () => withTransaction(fn));
  const read = <T>(fn: () => Promise<T>) => runInTenant(ctx(tenantA, ownerA), fn);
  const renderer = createChromiumRenderer({
    ...(executablePath ? { executablePath } : {}),
    timeoutMs: 120_000,
  });
  const acts = createRenderJobActivities({
    store: creativeRenderJobStore(),
    renderer,
    rendererVersion: RENDERER_VERSION,
    storage: mem,
  });
  const inputFor = (renderJobId: string): RenderJobInputV1 => ({
    tenantId: tenantA,
    actor: { kind: 'user', id: ownerA },
    correlationId: 'corr_render_e2e',
    renderJobId,
  });
  let brandVersionId = '';
  const seeded: Record<string, { assetId: string; versionId: string; contentHash: string }> = {};

  async function seedAsset(
    key: string,
    kind: 'photo' | 'font' | 'logo',
    mime: string,
    bytes: Buffer,
    w: number | null,
    h: number | null,
  ) {
    const id = newId('asset');
    const versionId = newId('assetVersion');
    const storageKey = storageKeys.original(tenantA, brandA, id, versionId);
    await tdb.db.insert(assets).values({
      id,
      tenantId: tenantA,
      brandId: brandA,
      kind,
      name: key,
      currentVersionId: versionId,
      state: 'approved',
      rightsState: 'recorded',
    });
    await tdb.db.insert(assetVersions).values({
      id: versionId,
      tenantId: tenantA,
      brandId: brandA,
      assetId: id,
      number: 1,
      storageKey,
      contentHash: sha256(bytes),
      mime,
      bytes: bytes.length,
      width: w,
      height: h,
      provenance: { kind: 'upload', uploadedByUserId: ownerA, originalFilename: key },
    });
    await tdb.db.insert(usageRights).values({
      id: newId('usageRights'),
      tenantId: tenantA,
      brandId: brandA,
      assetId: id,
      owner: 'owner',
      permittedChannels: 'all',
      territories: 'all',
      expiresAt: null,
      releases: [],
      restrictions: [],
    });
    await read(() => mem.putObject(storageKey, bytes, { contentType: mime }));
    seeded[key] = { assetId: id, versionId, contentHash: sha256(bytes) };
  }

  /** A published brand version seeded directly (the worker app has no brand-module dependency of its own). */
  async function publishBrand(document: BrandSystemDocumentV1) {
    const id = newId('brandVersion');
    await tdb.db.insert(brandVersions).values({
      id,
      tenantId: tenantA,
      brandId: brandA,
      number: 1,
      state: 'published',
      document,
      contentHash: hashCanonical(document),
      publishedAt: new Date(),
      publishedByUserId: ownerA,
    });
    await tdb.db.update(brands).set({ publishedVersionId: id }).where(eq(brands.id, brandA));
    return id;
  }

  async function createAndRequest(doc: CreativeDocumentV1, formatKeys: string[]) {
    const created = await run((tx) =>
      creativeService.documents.create(A, { brandId: brandA, title: 'Feed', document: doc }, tx),
    );
    const requested = await run((tx) =>
      creativeService.renders.request(
        A,
        { documentId: created.documentId, revisionId: created.revisionId, formatKeys },
        tx,
      ),
    );
    return { ...created, renderJobId: requested.renderJobId };
  }

  const jobRow = async (id: string) =>
    (await tdb.db.select().from(renderJobs).where(eq(renderJobs.id, id)))[0]!;
  const exportRows = (revisionId: string) =>
    tdb.db.select().from(renderedExports).where(eq(renderedExports.revisionId, revisionId));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureStorage(mem);
    registerAssetAuthoriser(async (assetVersionId, c, tx) => {
      await assetService.authoriseUse(assetVersionId, c.purpose, { brandId: c.brandId }, tx);
    });
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: `render-e2e-${tenantA.slice(-6).toLowerCase()}` });
    await tdb.db
      .insert(users)
      .values({ id: ownerA, email: `${ownerA.toLowerCase()}@example.test`, name: 'owner a' });
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A1',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await tdb.db.insert(memberships).values({
      id: newId('membership'),
      tenantId: tenantA,
      userId: ownerA,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    brandVersionId = await publishBrand(brandDocument());
    const font = await loadFixtureFont(FIXTURE_FONTS.karla);
    await seedAsset('font', 'font', font.mime, font.bytes, null, null);
    const photo = await generateFixtureAsset({
      assetVersionId: 'x',
      kind: 'gradient',
      width: 1600,
      height: 1200,
    });
    await seedAsset('photo', 'photo', photo.mime, photo.bytes, 1600, 1200);
    const logo = await generateFixtureAsset({ assetVersionId: 'x', kind: 'logo', width: 600, height: 180 });
    await seedAsset('logo', 'logo', logo.mime, logo.bytes, 600, 180);
  }, 180_000);
  afterAll(async () => {
    await renderer.close();
    await tdb?.drop();
  });

  const refs = () => ({
    font: seeded['font']!.versionId,
    photo: seeded['photo']!.versionId,
    logo: seeded['logo']!.versionId,
  });

  it('request → pending → rendering → ready: exports carry manifest, validation and the hash of the stored bytes', async () => {
    const { revisionId, renderJobId } = await createAndRequest(studioDocument(brandVersionId, refs()), [
      'square_1080',
      'ig_feed_4x5',
    ]);
    expect((await jobRow(renderJobId)).state).toBe('pending');
    const result = await runRenderJob(acts, inputFor(renderJobId));
    expect(result.outcome).toBe('ready');
    const job = await jobRow(renderJobId);
    expect(job).toMatchObject({ state: 'ready', attempts: 1, error: null });
    const rows = await exportRows(revisionId);
    expect(rows.map((r) => r.formatKey).sort()).toEqual(['ig_feed_4x5', 'square_1080']);
    expect(job.exportIds).toEqual(rows.map((r) => r.id).sort());
    for (const row of rows) {
      const bytes = await read(() => mem.getObject(row.storageKey));
      expect(bytes).not.toBeNull();
      expect(sha256(bytes!)).toBe(row.contentHash);
      expect(bytes!.length).toBe(row.bytes);
      expect(
        row.storageKey.startsWith(`assets/${tenantA}/${brandA}/exports/${revisionId}/${renderJobId}/`),
      ).toBe(true);
      expect(row).toMatchObject({ mime: 'image/png', pageId: 'page_1', rendererVersion: RENDERER_VERSION });
      expect(row.manifest).toMatchObject({
        rendererVersion: RENDERER_VERSION,
        brandVersionId,
        fonts: [{ assetVersionId: seeded['font']!.versionId, contentHash: seeded['font']!.contentHash }],
      });
      expect(row.manifest.assets.map((a) => a.assetVersionId).sort()).toEqual(
        [seeded['logo']!.versionId, seeded['photo']!.versionId].sort(),
      );
      const codes = row.validation.findings.map((f) => f.code);
      expect(codes).not.toContain('missing_font');
      expect(codes).not.toContain('missing_asset');
      expect(row.validation.ok).toBe(true);
    }
    const square = rows.find((r) => r.formatKey === 'square_1080')!;
    const feed = rows.find((r) => r.formatKey === 'ig_feed_4x5')!;
    expect({ w: square.width, h: square.height }).toEqual({ w: 1080, h: 1080 });
    expect({ w: feed.width, h: feed.height }).toEqual({ w: 1080, h: 1350 }); // reflowed variant
    // The API view of the job matches the rows.
    const view = await read(() => creativeService.renders.get(A, { renderJobId }));
    expect(view.state).toBe('ready');
    expect(view.exports.map((e) => e.contentHash).sort()).toEqual(rows.map((r) => r.contentHash).sort());
  }, 300_000);

  it('rendering the same revision twice yields byte-identical exports (same hash), never overwriting the first', async () => {
    const { documentId, revisionId, renderJobId } = await createAndRequest(
      studioDocument(brandVersionId, refs()),
      ['square_1080'],
    );
    expect((await runRenderJob(acts, inputFor(renderJobId))).outcome).toBe('ready');
    const second = await run((tx) =>
      creativeService.renders.request(A, { documentId, revisionId, formatKeys: ['square_1080'] }, tx),
    );
    expect((await runRenderJob(acts, inputFor(second.renderJobId))).outcome).toBe('ready');
    const rows = await exportRows(revisionId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.contentHash).toBe(rows[1]!.contentHash);
    expect(rows[0]!.storageKey).not.toBe(rows[1]!.storageKey);
    const a = await read(() => mem.getObject(rows[0]!.storageKey));
    const b = await read(() => mem.getObject(rows[1]!.storageKey));
    expect(a!.equals(b!)).toBe(true);
  }, 300_000);

  it('an asset that becomes ineligible before rendering fails the job with rights_ineligible and no export', async () => {
    const { revisionId, renderJobId } = await createAndRequest(studioDocument(brandVersionId, refs()), [
      'square_1080',
    ]);
    // Rights are re-checked at the point of effect (spec 9.2): retire the photo after the document was created.
    await tdb.db.update(assets).set({ state: 'retired' }).where(eq(assets.id, seeded['photo']!.assetId));
    try {
      const result = await runRenderJob(acts, inputFor(renderJobId));
      expect(result).toEqual({ outcome: 'failed', reason: 'rights_ineligible' });
      const job = await jobRow(renderJobId);
      expect(job.state).toBe('failed');
      expect(job.error).toMatch(/^rights_ineligible: .*state_not_approved/);
      expect(await exportRows(revisionId)).toEqual([]);
      expect(mem.keys().filter((k) => k.includes(`/${renderJobId}/`))).toEqual([]);
    } finally {
      await tdb.db.update(assets).set({ state: 'approved' }).where(eq(assets.id, seeded['photo']!.assetId));
    }
  }, 300_000);

  it('illegal transitions are rejected: ready before rendering, and a second start of a finished job', async () => {
    const { renderJobId } = await createAndRequest(studioDocument(brandVersionId, refs()), ['square_1080']);
    await expect(
      run((tx) =>
        creativeService.renders.markReady(
          {
            renderJobId,
            exports: [
              {
                pageId: 'page_1',
                formatKey: 'square_1080',
                mime: 'image/png',
                width: 1080,
                height: 1080,
                bytes: 1,
                storageKey: `assets/${tenantA}/${brandA}/exports/x/y/page_1-square_1080.png`,
                contentHash: 'a'.repeat(64),
                rendererVersion: RENDERER_VERSION,
                manifest: {
                  rendererVersion: RENDERER_VERSION,
                  fonts: [],
                  assets: [],
                  brandVersionId,
                  revisionContentHash: 'b'.repeat(64),
                },
                validation: { ok: true, findings: [] },
              },
            ],
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    expect((await runRenderJob(acts, inputFor(renderJobId))).outcome).toBe('ready');
    await expect(acts.beginRender(inputFor(renderJobId))).rejects.toBeInstanceOf(ValidationFailedError);
    // The workflow records the illegal state without rendering again; the job stays ready.
    expect(await runRenderJob(acts, inputFor(renderJobId))).toEqual({
      outcome: 'failed',
      reason: 'illegal_state',
    });
    expect((await jobRow(renderJobId)).state).toBe('ready');
  }, 300_000);
});
