import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Element, Operation } from '@oremedia/contracts/creative';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { assetVersions, assets, usageRights } from '@oremedia/db/schema/assets';
import { brandVersions, brands } from '@oremedia/db/schema/brand';
import { renderedExports } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createRenderJobActivities } from '@oremedia/activities';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import { renderFixtures, type RenderFixture } from '@oremedia/editor/renderer/fixtures';
import { MemoryStorageProvider, assetService, configureStorage, storageKeys } from '@oremedia/module-assets';
import { creativeService, registerAssetAuthoriser } from '@oremedia/module-creative';
import { runRenderJob } from '@oremedia/workflows/render-job.workflow.v1';
import { createChromiumRenderer } from './chromium-renderer';
import { creativeRenderJobStore } from './creative-store';
import {
  ACTUAL_DIR,
  GOLDEN_DIR,
  comparePng,
  diffPng,
  generateFixtureAsset,
  loadFixtureFont,
} from './fixture-assets';

/**
 * Phase 0 gate 0.g2 (spec 22): one fixture document round-trips save → reopen → render with a pixel diff under the
 * threshold. For each golden fixture brand (Latin/Karla, Arabic/Noto Naskh) the whole chain runs through the real
 * modules against MySQL and the real Chromium worker path:
 *   1. creative.documents.create with a DRAFT of the fixture (an element missing, text, position and style changed);
 *   2. creative.operations.apply with the person's edits that turn the draft into the fixture (insertElement,
 *      setText, moveElement, setStyle) → revision 2;
 *   3. reopen: creative.documents.get returns revision 2 whose snapshot is the fixture document;
 *   4. creative.renders.request for the reopened revision → renderJobWorkflowV1 orchestration (runRenderJob with the
 *      real activities: assets pinned through authoriseUse, bytes from the object store, headless Chromium);
 *   5. the stored export (its sha256 is the recorded content hash) is compared with the COMMITTED golden of that
 *      fixture (tooling/test-fixtures/golden, never written by this test).
 * Threshold: the golden suite's, at most 0.1 % of pixels differ where a pixel differs when any RGBA channel moves
 * by more than 2 (spec 19.5; golden.integration.test.ts MAX_DIFF_PERCENT / CHANNEL_TOLERANCE).
 * Requires OREMEDIA_CHROMIUM_PATH and the renderer bundle (pnpm --filter @oremedia/editor build:renderer).
 */
const MAX_DIFF_PERCENT = 0.1;
const CHANNEL_TOLERANCE = 2;
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const executablePath = process.env['OREMEDIA_CHROMIUM_PATH'];

/** Prefixed ids with a 26-character Crockford body (an app may not import the domain package's generator). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newId = (kind: IdKind): string =>
  `${ID_PREFIXES[kind]}_${[...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join('')}`;

const owner = (tenantId: string, userId: string): ResolvedActor => ({
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

/** The fixture document with its asset version ids replaced by the seeded ones (ids never change pixels). */
function withAssetIds(doc: CreativeDocumentV1, map: Map<string, string>, brandVersionId: string) {
  const remap = (el: Element): Element => {
    if (el.type === 'text')
      return {
        ...el,
        style: { ...el.style, fontAssetVersionId: map.get(el.style.fontAssetVersionId) ?? '' },
      };
    if (el.type === 'image' || el.type === 'logo')
      return { ...el, assetVersionId: map.get(el.assetVersionId) ?? '' };
    if (el.type === 'group') return { ...el, children: el.children.map(remap) };
    return el;
  };
  return {
    ...doc,
    brandVersionId,
    pages: doc.pages.map((p) => ({ ...p, elements: p.elements.map(remap) })),
  } satisfies CreativeDocumentV1;
}

type TopLevel = { index: number; el: Element };
const topLevel = (doc: CreativeDocumentV1, name: string): TopLevel => {
  const els = doc.pages[0]!.elements;
  const index = els.findIndex((e) => e.name === name);
  if (index < 0) throw new Error(`fixture has no top-level element named ${name}`);
  return { index, el: els[index]! };
};

/**
 * A draft of the fixture and the person's edits that turn it into the fixture: an element the draft lacks is
 * inserted back at its z-index, and the draft's headline text, one element's position and one text style differ.
 */
function draftAndEdits(
  target: CreativeDocumentV1,
  names: { inserted: string; moved: string; restyled: string },
): { draft: CreativeDocumentV1; operations: Operation[] } {
  const page = target.pages[0]!;
  const inserted = topLevel(target, names.inserted);
  const moved = topLevel(target, names.moved);
  const headline = topLevel(target, 'Headline');
  const restyled = topLevel(target, names.restyled);
  if (headline.el.type !== 'text' || restyled.el.type !== 'text') throw new Error('text elements expected');
  const draftText = 'Draft headline to be replaced';
  const draftAlign = restyled.el.style.align === 'center' ? 'left' : 'center';
  const draftElements = page.elements
    .filter((e) => e.id !== inserted.el.id)
    .map((e): Element => {
      if (e.id === moved.el.id)
        return { ...e, transform: { ...e.transform, x: e.transform.x + 37, y: e.transform.y - 23 } };
      if (e.id === headline.el.id && e.type === 'text') return { ...e, text: draftText };
      if (e.id === restyled.el.id && e.type === 'text')
        return { ...e, style: { ...e.style, align: draftAlign } };
      return e;
    });
  const draft = { ...target, pages: [{ ...page, elements: draftElements }] };
  const operations: Operation[] = [
    { op: 'insertElement', pageId: page.id, element: inserted.el, index: inserted.index },
    { op: 'setText', pageId: page.id, elementId: headline.el.id, text: headline.el.text },
    {
      op: 'moveElement',
      pageId: page.id,
      elementId: moved.el.id,
      x: moved.el.transform.x,
      y: moved.el.transform.y,
    },
    {
      op: 'setStyle',
      pageId: page.id,
      elementId: restyled.el.id,
      patch: { align: restyled.el.style.align },
    },
  ];
  return { draft, operations };
}

const EDITS: Record<string, { inserted: string; moved: string; restyled: string }> = {
  latin_feed_square: { inserted: 'Ring', moved: 'Panel', restyled: 'Body' },
  arabic_story_9x16: { inserted: 'Ribbon', moved: 'Mark', restyled: 'Label' },
};

describe('0.g2 round trip: create → apply → save → reopen → Chromium render → pixel diff against the committed golden', () => {
  let tdb: TestDatabase;
  const mem = new MemoryStorageProvider();
  const tenantId = newId('tenant');
  const userId = newId('user');
  const actor = owner(tenantId, userId);
  const ctx = (): TenantContext => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    brandIds: 'all',
    correlationId: 'corr_roundtrip',
  });
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx(), () => withTransaction(fn));
  const read = <T>(fn: () => Promise<T>) => runInTenant(ctx(), fn);
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
  /** Per fixture: its brand, published brand version and the fixture id → seeded asset version id map. */
  const seeded = new Map<string, { brandId: string; brandVersionId: string; ids: Map<string, string> }>();

  async function seedAsset(
    brandId: string,
    kind: 'photo' | 'font' | 'logo',
    name: string,
    mime: string,
    bytes: Buffer,
    size: { width: number; height: number } | null,
  ): Promise<string> {
    const id = newId('asset');
    const versionId = newId('assetVersion');
    const storageKey = storageKeys.original(tenantId, brandId, id, versionId);
    await tdb.db.insert(assets).values({
      id,
      tenantId,
      brandId,
      kind,
      name,
      currentVersionId: versionId,
      state: 'approved',
      rightsState: 'recorded',
    });
    await tdb.db.insert(assetVersions).values({
      id: versionId,
      tenantId,
      brandId,
      assetId: id,
      number: 1,
      storageKey,
      contentHash: sha256(bytes),
      mime,
      bytes: bytes.length,
      width: size?.width ?? null,
      height: size?.height ?? null,
      provenance: { kind: 'upload', uploadedByUserId: userId, originalFilename: name },
    });
    await tdb.db.insert(usageRights).values({
      id: newId('usageRights'),
      tenantId,
      brandId,
      assetId: id,
      owner: 'owner',
      permittedChannels: 'all',
      territories: 'all',
      expiresAt: null,
      releases: [],
      restrictions: [],
    });
    await read(() => mem.putObject(storageKey, bytes, { contentType: mime }));
    return versionId;
  }

  /** One brand per fixture, its published version carrying the fixture's brand system (colour tokens). */
  async function seedFixtureBrand(fixture: RenderFixture) {
    const brandId = newId('brand');
    await tdb.db.insert(brands).values({
      id: brandId,
      tenantId,
      name: fixture.key,
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    const brandVersionId = newId('brandVersion');
    const document: BrandSystemDocumentV1 = fixture.snapshot.document;
    await tdb.db.insert(brandVersions).values({
      id: brandVersionId,
      tenantId,
      brandId,
      number: 1,
      state: 'published',
      document,
      contentHash: sha256(Buffer.from(JSON.stringify(document))),
      publishedAt: new Date(),
      publishedByUserId: userId,
    });
    await tdb.db.update(brands).set({ publishedVersionId: brandVersionId }).where(eq(brands.id, brandId));
    const ids = new Map<string, string>();
    for (const f of fixture.fonts) {
      const font = await loadFixtureFont(f);
      ids.set(f.assetVersionId, await seedAsset(brandId, 'font', f.file, font.mime, font.bytes, null));
    }
    for (const a of fixture.assets) {
      const generated = await generateFixtureAsset(a);
      const kind = a.kind === 'logo' ? 'logo' : 'photo';
      ids.set(
        a.assetVersionId,
        await seedAsset(brandId, kind, a.assetVersionId, generated.mime, generated.bytes, {
          width: a.width,
          height: a.height,
        }),
      );
    }
    seeded.set(fixture.key, { brandId, brandVersionId, ids });
  }

  beforeAll(async () => {
    await mkdir(ACTUAL_DIR, { recursive: true });
    tdb = await createTestDatabase();
    configureStorage(mem);
    registerAssetAuthoriser(async (assetVersionId, c, tx) => {
      await assetService.authoriseUse(assetVersionId, c.purpose, { brandId: c.brandId }, tx);
    });
    await tdb.db
      .insert(tenants)
      .values({ id: tenantId, name: 'Round trip', slug: `roundtrip-${tenantId.slice(-6).toLowerCase()}` });
    await tdb.db
      .insert(users)
      .values({ id: userId, email: `${userId.toLowerCase()}@example.test`, name: 'owner' });
    await tdb.db.insert(memberships).values({
      id: newId('membership'),
      tenantId,
      userId,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    for (const fixture of renderFixtures()) await seedFixtureBrand(fixture);
  }, 180_000);
  afterAll(async () => {
    await renderer.close();
    await tdb?.drop();
  });

  it.each(renderFixtures().map((f) => [f.key] as const))(
    '%s: the reopened revision renders within 0.1 % of the committed golden (channel tolerance 2)',
    async (key) => {
      const fixture = renderFixtures().find((f) => f.key === key)!;
      const goldenPath = join(GOLDEN_DIR, `${key}.png`);
      expect(existsSync(goldenPath), `committed golden ${goldenPath}`).toBe(true);
      const s = seeded.get(key)!;
      const target = withAssetIds(fixture.document, s.ids, s.brandVersionId);
      const { draft, operations } = draftAndEdits(target, EDITS[key]!);
      expect(draft).not.toEqual(target);

      // 1. create (save revision 1: the draft)
      const created = await run((tx) =>
        creativeService.documents.create(actor, { brandId: s.brandId, title: key, document: draft }, tx),
      );
      expect(created.number).toBe(1);

      // 2. apply the person's edits (save revision 2)
      const applied = await run((tx) =>
        creativeService.operations.apply(
          actor,
          {
            documentId: created.documentId,
            baseRevisionId: created.revisionId,
            operations,
            summary: 'Finish the fixture',
            origin: 'user',
          },
          tx,
        ),
      );
      expect(applied.revision.number).toBe(2);
      // The static pre-render check reads the colours actually under each text (the badge, the ribbon), so the
      // finished fixture has no blocking finding before render either (docs/spikes/editor-bake-off.md, gap 3 closed).
      expect(applied.findings.filter((f) => f.severity === 'blocking')).toEqual([]);

      // 3. reopen: the document's current revision is revision 2 and its snapshot is the fixture document
      const reopened = await read(() =>
        creativeService.documents.get(actor, { documentId: created.documentId }),
      );
      expect(reopened.revision.id).toBe(applied.revision.id);
      expect(reopened.revision.number).toBe(2);
      expect(reopened.revision.contentHash).toBe(applied.revision.contentHash);
      expect(reopened.revision.contentHash).not.toBe(created.contentHash);
      expect(reopened.revision.snapshot).toEqual(target);

      // 4. render the reopened revision through the render job (real activities + Chromium)
      const requested = await run((tx) =>
        creativeService.renders.request(
          actor,
          {
            documentId: created.documentId,
            revisionId: reopened.revision.id,
            formatKeys: [fixture.formatKey],
          },
          tx,
        ),
      );
      const result = await runRenderJob(acts, {
        tenantId,
        actor: { kind: 'user', id: userId },
        correlationId: 'corr_roundtrip',
        renderJobId: requested.renderJobId,
      });
      expect(result.outcome).toBe('ready');
      const rows = await tdb.db
        .select()
        .from(renderedExports)
        .where(eq(renderedExports.revisionId, reopened.revision.id));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.manifest.revisionContentHash).toBe(reopened.revision.contentHash);
      expect(row.validation.findings.filter((f) => f.severity === 'blocking')).toEqual([]);
      const png = await read(() => mem.getObject(row.storageKey));
      expect(png).not.toBeNull();
      expect(sha256(png!)).toBe(row.contentHash);

      // 5. pixel diff against the committed golden
      await writeFile(join(ACTUAL_DIR, `${key}.roundtrip.png`), png!);
      const golden = await readFile(goldenPath);
      const cmp = comparePng(golden, png!, CHANNEL_TOLERANCE);
      if (cmp.differing > 0) {
        const diff = diffPng(golden, png!);
        if (diff) await writeFile(join(ACTUAL_DIR, `${key}.roundtrip.diff.png`), diff);
      }
      console.error(
        `${key} round trip vs golden: ${cmp.differing}/${cmp.total} pixels differ (${cmp.percent.toFixed(4)} %); export ${row.contentHash.slice(0, 12)}`,
      );
      expect(cmp.sameDimensions).toBe(true);
      expect(cmp.percent).toBeLessThanOrEqual(MAX_DIFF_PERCENT);
    },
    300_000,
  );
});
