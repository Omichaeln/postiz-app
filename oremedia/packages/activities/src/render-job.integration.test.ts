import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { MockActivityEnvironment } from '@temporalio/testing';
import type { BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Element, RenderExportInput } from '@oremedia/contracts/creative';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { RenderJobInputV1, RenderResolveSuccess } from '@oremedia/contracts/render';
import type { Tx } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { brandGrants, memberships, tenants, users } from '@oremedia/db/schema/access';
import { assetVersions, assets, usageRights } from '@oremedia/db/schema/assets';
import { brandVersions, brands } from '@oremedia/db/schema/brand';
import { emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import { renderJobMachine } from '@oremedia/domain';
import { hashCanonical } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import { MemoryStorageProvider, configureStorage, storageKeys } from '@oremedia/module-assets';
import {
  RenderIntegrityError,
  createRenderJobActivities,
  exportStorageKey,
  referencedAssets,
  resolveTargets,
  type FormatRenderer,
  type RenderJobStore,
  type RenderTargetInput,
} from './render-job';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A minimal valid RGB PNG built here so this package needs no image library; the pixels encode the input. */
function tinyPng(width: number, height: number, seed: number): Buffer {
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
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++)
    rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, (0x40 + y + seed) & 0xff)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
    ],
    typeRoles: [
      { role: 'display', fontAssetId: 'ast_font', weight: 600, minSizePx: 40 },
      { role: 'body', fontAssetId: 'ast_font', weight: 400, minSizePx: 18 },
    ],
    spacingScale: [4, 8],
    radii: [0],
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

const el = {
  bg: newElementId(),
  headline: newElementId(),
  photo: newElementId(),
  logo: newElementId(),
  hidden: newElementId(),
};

function studioDocument(
  brandVersionId: string,
  refs: { font: string; photo: string; logo: string; hidden?: string },
) {
  const doc: CreativeDocumentV1 = {
    schemaVersion: 1,
    brandVersionId,
    pages: [
      {
        id: 'page_1',
        name: 'Feed',
        formatKey: 'square_1080',
        width: 1080,
        height: 1080,
        layoutConstraints: [],
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
          },
          {
            id: el.headline,
            name: 'Headline',
            type: 'text',
            locked: false,
            visible: true,
            opacity: 1,
            protected: false,
            transform: { x: 80, y: 80, width: 920, height: 120, rotation: 0 },
            text: 'October offer',
            style: {
              typeRole: 'display',
              fontAssetVersionId: refs.font,
              weight: 600,
              sizePx: 64,
              lineHeight: 1.2,
              tracking: 0,
              colourToken: 'ink',
              align: 'left',
              overflow: 'error',
            },
            factRefs: [],
          },
          {
            id: el.logo,
            name: 'Logo',
            type: 'logo',
            locked: false,
            visible: true,
            opacity: 1,
            protected: true,
            semanticRole: 'logo',
            transform: { x: 80, y: 900, width: 200, height: 60, rotation: 0 },
            assetVersionId: refs.logo,
            variant: 'primary',
          },
          ...(refs.hidden
            ? [
                {
                  id: el.hidden,
                  name: 'Hidden',
                  type: 'image' as const,
                  locked: false,
                  visible: false,
                  opacity: 1,
                  protected: false,
                  transform: { x: 0, y: 0, width: 10, height: 10, rotation: 0 },
                  assetVersionId: refs.hidden,
                  fit: 'cover' as const,
                } satisfies Element,
              ]
            : []),
        ],
      },
    ],
    variants: [],
  };
  return doc;
}

interface StoredJob {
  renderJobId: string;
  tenantId: string;
  state: 'pending' | 'rendering' | 'ready' | 'failed';
  revisionId: string;
  documentId: string;
  brandId: string;
  formatKeys: string[];
  exports: RenderExportInput[];
  error: string | null;
  transitions: string[];
}

/**
 * The creative module's render-job surface, faked with the real state machine so illegal moves are rejected the
 * same way (apps/worker-render's integration test drives the real creativeService end to end).
 */
class FakeStore implements RenderJobStore {
  readonly jobs = new Map<string, StoredJob>();
  readonly revisions = new Map<
    string,
    { snapshot: CreativeDocumentV1; contentHash: string; brandVersionId: string }
  >();

  add(job: Omit<StoredJob, 'state' | 'exports' | 'error' | 'transitions'>): string {
    this.jobs.set(job.renderJobId, { ...job, state: 'pending', exports: [], error: null, transitions: [] });
    return job.renderJobId;
  }
  private job(id: string): StoredJob {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundError('RenderJob', id);
    return job;
  }
  private move(job: StoredJob, event: 'start' | 'succeed' | 'fail') {
    try {
      const next = renderJobMachine.transition(job.state, event);
      job.transitions.push(`${job.state}->${next}`);
      job.state = next;
    } catch (err) {
      throw new ValidationFailedError([{ path: 'renderJobId', issue: (err as Error).message }]);
    }
  }
  async getJob(_actor: unknown, renderJobId: string) {
    const { exports: _e, error: _err, transitions: _t, tenantId: _ten, ...view } = this.job(renderJobId);
    return view;
  }
  async getRevision(_actor: unknown, documentId: string, revisionId: string) {
    const r = this.revisions.get(`${documentId}/${revisionId}`);
    if (!r) throw new NotFoundError('CreativeRevision', revisionId);
    return r;
  }
  async markRendering(renderJobId: string, _tx: Tx) {
    this.move(this.job(renderJobId), 'start');
  }
  async markReady(renderJobId: string, exports: RenderExportInput[], _tx: Tx) {
    const job = this.job(renderJobId);
    this.move(job, 'succeed');
    job.exports = exports;
    return { exportIds: exports.map((_e, n) => `exp_${renderJobId}_${n + 1}`) };
  }
  async markFailed(renderJobId: string, error: string, _tx: Tx) {
    const job = this.job(renderJobId);
    this.move(job, 'fail');
    job.error = error;
  }
}

/** A renderer that draws nothing but proves what it was given: the PNG pixels depend on every input byte. */
function fakeRenderer(): FormatRenderer & { calls: RenderTargetInput[] } {
  const calls: RenderTargetInput[] = [];
  return {
    calls,
    async render(input) {
      calls.push(input);
      const size = input.formatKey === 'ig_feed_4x5' ? { width: 8, height: 10 } : { width: 8, height: 8 };
      const seed =
        Number(
          BigInt(
            `0x${sha256(Buffer.concat([...input.fonts, ...input.assets].map((x) => x.bytes))).slice(0, 8)}`,
          ) % 200n,
        ) + input.page.elements.length;
      return { png: tinyPng(size.width, size.height, seed), ...size, findings: [] };
    },
  };
}

describe('render job activities (MockActivityEnvironment against MySQL)', () => {
  let tdb: TestDatabase;
  const mem = new MemoryStorageProvider();
  const env = new MockActivityEnvironment();
  const run = <A, R>(fn: (arg: A) => Promise<R>, arg: A): Promise<R> => env.run(fn, arg) as Promise<R>;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const ownerA = newId('user');
  const ownerB = newId('user');
  const brandVersionA = newId('brandVersion');
  const brandVersionB = newId('brandVersion');
  const store = new FakeStore();
  const renderer = fakeRenderer();
  const acts = createRenderJobActivities({ store, renderer, rendererVersion: '1.0.0-test', storage: mem });
  const inputFor = (userId: string, tenantId: string, renderJobId: string): RenderJobInputV1 => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    correlationId: 'corr_render',
    renderJobId,
  });
  const seeded: Record<string, { versionId: string; bytes: Buffer; contentHash: string }> = {};

  /** Direct seed of an asset with one version whose bytes live in the store and hash as catalogued. */
  async function seedAsset(opts: {
    key: string;
    tenantId: string;
    brandId: string;
    kind: 'photo' | 'font' | 'logo';
    rights: boolean;
    bytes: Buffer;
  }) {
    const id = newId('asset');
    const versionId = newId('assetVersion');
    const storageKey = storageKeys.original(opts.tenantId, opts.brandId, id, versionId);
    await tdb.db.insert(assets).values({
      id,
      tenantId: opts.tenantId,
      brandId: opts.brandId,
      kind: opts.kind,
      name: opts.key,
      currentVersionId: versionId,
      state: 'approved',
      rightsState: opts.rights ? 'recorded' : 'unknown',
    });
    await tdb.db.insert(assetVersions).values({
      id: versionId,
      tenantId: opts.tenantId,
      brandId: opts.brandId,
      assetId: id,
      number: 1,
      storageKey,
      contentHash: sha256(opts.bytes),
      mime: opts.kind === 'font' ? 'font/ttf' : 'image/png',
      bytes: opts.bytes.length,
      width: opts.kind === 'font' ? null : 8,
      height: opts.kind === 'font' ? null : 8,
      provenance: { kind: 'upload', uploadedByUserId: ownerA, originalFilename: `${opts.key}.bin` },
    });
    if (opts.rights)
      await tdb.db.insert(usageRights).values({
        id: newId('usageRights'),
        tenantId: opts.tenantId,
        brandId: opts.brandId,
        assetId: id,
        owner: 'owner',
        permittedChannels: 'all',
        territories: 'all',
        expiresAt: null,
        releases: [],
        restrictions: [],
      });
    // Written outside tenant context is impossible: the provider enforces the prefix, so seed under the tenant.
    const { runInTenant } = await import('@oremedia/db');
    await runInTenant(
      {
        tenantId: opts.tenantId,
        actor: { kind: 'user', id: ownerA },
        brandIds: 'all',
        correlationId: 'seed',
      },
      () => mem.putObject(storageKey, opts.bytes, { contentType: 'application/octet-stream' }),
    );
    seeded[opts.key] = { versionId, bytes: opts.bytes, contentHash: sha256(opts.bytes) };
    return versionId;
  }

  function seedRevision(
    tenantId: string,
    brandId: string,
    doc: CreativeDocumentV1,
    formatKeys: string[],
  ): { renderJobId: string; revisionId: string; documentId: string } {
    const documentId = newId('creativeDocument');
    const revisionId = newId('creativeRevision');
    store.revisions.set(`${documentId}/${revisionId}`, {
      snapshot: doc,
      contentHash: hashCanonical(doc),
      brandVersionId: doc.brandVersionId,
    });
    const renderJobId = store.add({
      renderJobId: newId('renderJob'),
      tenantId,
      revisionId,
      documentId,
      brandId,
      formatKeys,
    });
    return { renderJobId, revisionId, documentId };
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureStorage(mem);
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: `render-a-${tenantA.slice(-6).toLowerCase()}` },
      { id: tenantB, name: 'B', slug: `render-b-${tenantB.slice(-6).toLowerCase()}` },
    ]);
    await tdb.db.insert(users).values([
      { id: ownerA, email: `${ownerA.toLowerCase()}@example.test`, name: 'owner a' },
      { id: ownerB, email: `${ownerB.toLowerCase()}@example.test`, name: 'owner b' },
    ]);
    await tdb.db.insert(brands).values([
      {
        id: brandA,
        tenantId: tenantA,
        name: 'A1',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'active',
        publishedVersionId: brandVersionA,
      },
      {
        id: brandB,
        tenantId: tenantB,
        name: 'B1',
        timezone: 'UTC',
        defaultLocale: 'en',
        status: 'active',
        publishedVersionId: brandVersionB,
      },
    ]);
    const document = brandDocument();
    await tdb.db.insert(brandVersions).values([
      {
        id: brandVersionA,
        tenantId: tenantA,
        brandId: brandA,
        number: 1,
        state: 'published',
        document,
        contentHash: hashCanonical(document),
        publishedAt: new Date(),
        publishedByUserId: ownerA,
      },
      {
        id: brandVersionB,
        tenantId: tenantB,
        brandId: brandB,
        number: 1,
        state: 'published',
        document,
        contentHash: hashCanonical(document),
        publishedAt: new Date(),
        publishedByUserId: ownerB,
      },
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
        id: newId('membership'),
        tenantId: tenantB,
        userId: ownerB,
        role: 'owner',
        status: 'active',
        allBrands: true,
      },
    ]);
    void brandGrants;
    await seedAsset({
      key: 'font',
      tenantId: tenantA,
      brandId: brandA,
      kind: 'font',
      rights: false,
      bytes: Buffer.from('font-bytes-karla'),
    });
    await seedAsset({
      key: 'photo',
      tenantId: tenantA,
      brandId: brandA,
      kind: 'photo',
      rights: true,
      bytes: tinyPng(8, 8, 1),
    });
    await seedAsset({
      key: 'logo',
      tenantId: tenantA,
      brandId: brandA,
      kind: 'logo',
      rights: true,
      bytes: tinyPng(8, 8, 2),
    });
    await seedAsset({
      key: 'norights',
      tenantId: tenantA,
      brandId: brandA,
      kind: 'photo',
      rights: false,
      bytes: tinyPng(8, 8, 3),
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  const refs = () => ({
    font: seeded['font']!.versionId,
    photo: seeded['photo']!.versionId,
    logo: seeded['logo']!.versionId,
  });

  /** Drives the activities exactly as renderJobWorkflowV1 does. */
  async function renderJob(input: RenderJobInputV1) {
    const begun = await run(acts.beginRender, input);
    const resolved = await run(acts.resolveRenderInputs, { ...input, ...begun });
    if (!resolved.ok) {
      await run(acts.failRender, {
        ...input,
        reason: resolved.reason,
        ...(resolved.detail ? { detail: resolved.detail } : {}),
      });
      return { resolved, exports: [] };
    }
    const exports = [];
    for (const target of resolved.targets) {
      const rendered = await run(acts.renderFormat, {
        ...input,
        ...begun,
        brandVersionId: resolved.brandVersionId,
        target,
        fonts: resolved.fonts,
        assets: resolved.assets,
        rendererVersion: resolved.rendererVersion,
      });
      const stored = await run(acts.storeExport, { ...input, brandId: begun.brandId, export: rendered });
      exports.push({ ...rendered, ...stored });
    }
    await run(acts.completeRender, {
      ...input,
      rendererVersion: resolved.rendererVersion,
      manifest: resolved.manifest,
      exports,
    });
    return { resolved, exports };
  }

  it('pending → rendering → ready: pinned manifest, tenant-prefixed exports whose hash is the stored bytes', async () => {
    const doc = studioDocument(brandVersionA, { ...refs(), hidden: seeded['norights']!.versionId });
    const { renderJobId, revisionId } = seedRevision(tenantA, brandA, doc, ['square_1080', 'ig_feed_4x5']);
    const input = inputFor(ownerA, tenantA, renderJobId);
    const { resolved, exports } = await renderJob(input);
    expect(resolved.ok).toBe(true);
    const ok = resolved as RenderResolveSuccess;
    // Every font and visible image/logo asset version is pinned by hash; the hidden (ineligible) one is not used.
    expect(ok.manifest).toEqual({
      rendererVersion: '1.0.0-test',
      fonts: [{ assetVersionId: seeded['font']!.versionId, contentHash: seeded['font']!.contentHash }],
      assets: [
        { assetVersionId: seeded['photo']!.versionId, contentHash: seeded['photo']!.contentHash },
        { assetVersionId: seeded['logo']!.versionId, contentHash: seeded['logo']!.contentHash },
      ],
      brandVersionId: brandVersionA,
      revisionContentHash: hashCanonical(doc),
    });
    expect(ok.targets).toEqual([
      { pageId: 'page_1', formatKey: 'square_1080', reflow: false },
      { pageId: 'page_1', formatKey: 'ig_feed_4x5', reflow: true },
    ]);
    const job = store.jobs.get(renderJobId)!;
    expect(job.transitions).toEqual(['pending->rendering', 'rendering->ready']);
    expect(job.state).toBe('ready');
    expect(job.exports.map((e) => e.formatKey)).toEqual(['square_1080', 'ig_feed_4x5']);
    for (const e of job.exports) {
      expect(e.storageKey).toBe(
        exportStorageKey(tenantA, brandA, revisionId, renderJobId, 'page_1', e.formatKey),
      );
      expect(e.storageKey.startsWith(`assets/${tenantA}/${brandA}/exports/`)).toBe(true);
      const { runInTenant } = await import('@oremedia/db');
      const bytes = await runInTenant(
        { tenantId: tenantA, actor: { kind: 'user', id: ownerA }, brandIds: 'all', correlationId: 'read' },
        () => mem.getObject(e.storageKey),
      );
      expect(bytes).not.toBeNull();
      expect(sha256(bytes!)).toBe(e.contentHash);
      expect(bytes!.length).toBe(e.bytes);
      expect(e).toMatchObject({
        mime: 'image/png',
        rendererVersion: '1.0.0-test',
        manifest: ok.manifest,
        validation: { ok: true },
      });
    }
    expect(exports.map((e) => e.height)).toEqual([8, 10]);
    // The renderer received the pinned bytes, the brand snapshot and the reflow instruction.
    const call = renderer.calls.at(-1)!;
    expect(call.fonts.map((f) => f.family)).toEqual([seeded['font']!.versionId]);
    expect(call.fonts[0]!.bytes.equals(seeded['font']!.bytes)).toBe(true);
    expect(call.assets.map((a) => a.assetVersionId).sort()).toEqual(
      [seeded['logo']!.versionId, seeded['photo']!.versionId].sort(),
    );
    expect(call.snapshot.brandVersionId).toBe(brandVersionA);
    expect(call.reflow).toBe(true);
  });

  it('rendering the same revision twice yields byte-identical exports (same hash)', async () => {
    const doc = studioDocument(brandVersionA, refs());
    const first = seedRevision(tenantA, brandA, doc, ['square_1080']);
    const second = {
      ...first,
      renderJobId: store.add({
        renderJobId: newId('renderJob'),
        tenantId: tenantA,
        revisionId: first.revisionId,
        documentId: first.documentId,
        brandId: brandA,
        formatKeys: ['square_1080'],
      }),
    };
    const a = await renderJob(inputFor(ownerA, tenantA, first.renderJobId));
    const b = await renderJob(inputFor(ownerA, tenantA, second.renderJobId));
    expect(a.exports[0]!.contentHash).toBe(b.exports[0]!.contentHash);
    expect(a.exports[0]!.storageKey).not.toBe(b.exports[0]!.storageKey); // a re-render never overwrites an export
  });

  it('an asset the authoriser rejects fails the job with rights_ineligible and writes no export', async () => {
    const doc = studioDocument(brandVersionA, { ...refs(), photo: seeded['norights']!.versionId });
    const { renderJobId } = seedRevision(tenantA, brandA, doc, ['square_1080']);
    const before = mem.keys().length;
    const { resolved } = await renderJob(inputFor(ownerA, tenantA, renderJobId));
    expect(resolved).toMatchObject({ ok: false, reason: 'rights_ineligible' });
    const job = store.jobs.get(renderJobId)!;
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/^rights_ineligible: .*rights_unknown/);
    expect(job.exports).toEqual([]);
    expect(mem.keys().length).toBe(before);
  });

  it('a format no page carries fails with format_not_in_document only when nothing can be reflowed', async () => {
    const doc = studioDocument(brandVersionA, refs());
    expect(resolveTargets(doc, ['x_1600x900'])).toEqual({
      ok: true,
      targets: [{ pageId: 'page_1', formatKey: 'x_1600x900', reflow: true }],
    });
    expect(resolveTargets({ ...doc, pages: [] }, ['square_1080'])).toEqual({
      ok: false,
      detail: 'no page for format square_1080',
    });
    expect(referencedAssets(doc)).toEqual({
      fonts: [refs().font],
      images: [refs().photo],
      logos: [refs().logo],
    });
  });

  it('an illegal state is rejected: begin on a ready job fails, fail on a non-rendering job is a no-op', async () => {
    const doc = studioDocument(brandVersionA, refs());
    const { renderJobId } = seedRevision(tenantA, brandA, doc, ['square_1080']);
    const input = inputFor(ownerA, tenantA, renderJobId);
    await renderJob(input);
    expect(store.jobs.get(renderJobId)!.state).toBe('ready');
    await expect(run(acts.beginRender, input)).rejects.toBeInstanceOf(ValidationFailedError);
    await run(acts.failRender, { ...input, reason: 'render_failed', detail: 'late' });
    expect(store.jobs.get(renderJobId)!.state).toBe('ready');
    // A begin re-delivered while the job is already rendering continues instead of failing (idempotent start).
    const again = seedRevision(tenantA, brandA, doc, ['square_1080']);
    const input2 = inputFor(ownerA, tenantA, again.renderJobId);
    await run(acts.beginRender, input2);
    expect(await run(acts.beginRender, input2)).toMatchObject({ renderJobId: again.renderJobId });
    expect(store.jobs.get(again.renderJobId)!.transitions).toEqual(['pending->rendering']);
  });

  it('cross-tenant: tenant B cannot pin tenant A’s assets, read its objects or store under its prefix', async () => {
    const doc = studioDocument(brandVersionB, refs()); // tenant B document referencing tenant A asset versions
    const { renderJobId, revisionId, documentId } = seedRevision(tenantB, brandB, doc, ['square_1080']);
    const input = inputFor(ownerB, tenantB, renderJobId);
    const begun = await run(acts.beginRender, input);
    await expect(run(acts.resolveRenderInputs, { ...input, ...begun })).rejects.toBeInstanceOf(NotFoundError);
    const font = seeded['font']!;
    await expect(
      run(acts.renderFormat, {
        ...input,
        revisionId,
        documentId,
        brandId: brandB,
        brandVersionId: brandVersionB,
        target: { pageId: 'page_1', formatKey: 'square_1080', reflow: false },
        fonts: [
          {
            assetVersionId: font.versionId,
            storageKey: storageKeys.original(tenantA, brandA, 'ast_x', font.versionId),
            contentHash: font.contentHash,
            mime: 'font/ttf',
          },
        ],
        assets: [],
        rendererVersion: '1.0.0-test',
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(
      run(acts.storeExport, {
        ...input,
        brandId: brandB,
        export: {
          pageId: 'page_1',
          formatKey: 'square_1080',
          storageKey: exportStorageKey(tenantA, brandA, 'rev_x', 'rj_x', 'page_1', 'square_1080'),
          contentHash: 'a'.repeat(64),
          bytes: 1,
          width: 1,
          height: 1,
          mime: 'image/png',
          findings: [],
        },
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    // A user who is not a member of the tenant at all.
    await expect(run(acts.beginRender, inputFor(ownerB, tenantA, renderJobId))).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
  });

  it('tampered bytes are an integrity failure: a pinned asset or an export that no longer hashes as recorded', async () => {
    const doc = studioDocument(brandVersionA, refs());
    const { renderJobId } = seedRevision(tenantA, brandA, doc, ['square_1080']);
    const input = inputFor(ownerA, tenantA, renderJobId);
    const begun = await run(acts.beginRender, input);
    const resolved = (await run(acts.resolveRenderInputs, { ...input, ...begun })) as RenderResolveSuccess;
    const tampered = { ...resolved.fonts[0]!, contentHash: 'f'.repeat(64) };
    await expect(
      run(acts.renderFormat, {
        ...input,
        ...begun,
        brandVersionId: resolved.brandVersionId,
        target: resolved.targets[0]!,
        fonts: [tampered],
        assets: resolved.assets,
        rendererVersion: resolved.rendererVersion,
      }),
    ).rejects.toBeInstanceOf(RenderIntegrityError);
    const rendered = await run(acts.renderFormat, {
      ...input,
      ...begun,
      brandVersionId: resolved.brandVersionId,
      target: resolved.targets[0]!,
      fonts: resolved.fonts,
      assets: resolved.assets,
      rendererVersion: resolved.rendererVersion,
    });
    await expect(
      run(acts.storeExport, {
        ...input,
        brandId: begun.brandId,
        export: { ...rendered, contentHash: 'e'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(RenderIntegrityError);
    expect(await run(acts.storeExport, { ...input, brandId: begun.brandId, export: rendered })).toEqual({
      storageKey: rendered.storageKey,
      contentHash: rendered.contentHash,
      bytes: rendered.bytes,
    });
  });
});
