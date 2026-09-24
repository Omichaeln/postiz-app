import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { RenderJobInputV1 } from '@oremedia/contracts/render';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brandVersions, brands } from '@oremedia/db/schema/brand';
import {
  creativeRevisions,
  previewExports,
  renderJobs,
  renderPreviews,
  renderedExports,
} from '@oremedia/db/schema/creative';
import { featureFlags, outboxEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createRenderJobActivities } from '@oremedia/activities';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import { MemoryStorageProvider, assetService, configureStorage } from '@oremedia/module-assets';
import { creativeService, registerAssetAuthoriser } from '@oremedia/module-creative';
import { runRenderJob } from '@oremedia/workflows/render-job.workflow.v1';
import { createChromiumRenderer } from './chromium-renderer';
import { creativeRenderJobStore } from './creative-store';

/**
 * Ledger 3.10 (spec 11.4): operations.propose with previewRender queues a worker render of the proposed snapshot
 * through the existing render path (renderJobWorkflowV1's orchestration with the real activities and Chromium).
 * Nothing is committed to the document; the output is a preview export marked publishable: false, stored apart
 * from the revision's exports, never a rendered_exports row. The committed-revision render path is unchanged.
 * Requires OREMEDIA_CHROMIUM_PATH and the renderer bundle (pnpm --filter @oremedia/editor build:renderer).
 */
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const executablePath = process.env['OREMEDIA_CHROMIUM_PATH'];

/** Prefixed ids with a 26-character Crockford body (an app may not import the domain package's generator). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newId = (kind: IdKind): string =>
  `${ID_PREFIXES[kind]}_${[...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join('')}`;

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  tokens: {
    ...emptyBrandSystemDocument().tokens,
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
      { key: 'accent', value: '#0F6E63', role: 'accent' },
    ],
  },
});

const el = { bg: newId('element'), block: newId('element') };
const document = (brandVersionId: string): CreativeDocumentV1 => ({
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
      layoutConstraints: [],
      elements: [
        {
          id: el.bg,
          name: 'Background',
          type: 'background',
          locked: false,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 0, y: 0, width: 1080, height: 1080, rotation: 0 },
          fillToken: 'paper',
        },
        {
          id: el.block,
          name: 'Block',
          type: 'shape',
          locked: false,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 80, y: 80, width: 400, height: 400, rotation: 0 },
          shape: 'rect',
          fillToken: 'accent',
          strokeWidth: 0,
          cornerRadius: 0,
        },
      ],
    },
  ],
});

describe('proposal preview rendered by the worker (ledger 3.10)', () => {
  let tdb: TestDatabase;
  const mem = new MemoryStorageProvider();
  const tenantA = newId('tenant');
  const brandA = newId('brand');
  const ownerA = newId('user');
  const A: ResolvedActor = {
    kind: 'user',
    id: ownerA,
    tenantId: tenantA,
    membershipId: `mem_${ownerA}`,
    membershipStatus: 'active',
    role: 'owner',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  };
  const ctx: TenantContext = {
    tenantId: tenantA,
    actor: { kind: 'user', id: ownerA },
    brandIds: 'all',
    correlationId: 'corr_preview_render',
  };
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx, () => withTransaction(fn));
  const read = <T>(fn: () => Promise<T>) => runInTenant(ctx, fn);
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
    correlationId: 'corr_preview_render',
    renderJobId,
  });
  let documentId = '';
  let baseRevisionId = '';

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureStorage(mem);
    registerAssetAuthoriser(async (assetVersionId, c, tx) => {
      await assetService.authoriseUse(assetVersionId, c.purpose, { brandId: c.brandId }, tx);
    });
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: `preview-${tenantA.slice(-6).toLowerCase()}` });
    await tdb.db
      .insert(users)
      .values({ id: ownerA, email: `${ownerA.toLowerCase()}@example.test`, name: 'A' });
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
    const brandVersionId = newId('brandVersion');
    const bd = brandDocument();
    await tdb.db.insert(brandVersions).values({
      id: brandVersionId,
      tenantId: tenantA,
      brandId: brandA,
      number: 1,
      state: 'published',
      document: bd,
      contentHash: sha256(Buffer.from(JSON.stringify(bd))),
      publishedAt: new Date(),
      publishedByUserId: ownerA,
    });
    await tdb.db.update(brands).set({ publishedVersionId: brandVersionId }).where(eq(brands.id, brandA));
    const created = await run((tx) =>
      creativeService.documents.create(
        A,
        { brandId: brandA, title: 'Feed', document: document(brandVersionId) },
        tx,
      ),
    );
    documentId = created.documentId;
    baseRevisionId = created.revisionId;
  });
  afterAll(async () => {
    await renderer.close();
    await tdb?.drop();
  });

  const propose = (previewRender?: { formatKeys: string[] }) =>
    run((tx) =>
      creativeService.operations.propose(
        A,
        {
          documentId,
          baseRevisionId,
          operations: [{ op: 'moveElement', pageId: 'page_1', elementId: el.block, x: 600, y: 600 }],
          summary: 'move the block',
          origin: 'user',
          ...(previewRender ? { previewRender } : {}),
        },
        tx,
      ),
    );

  it('without previewRender nothing is queued (the scene preview only)', async () => {
    const proposal = await propose();
    expect(proposal.preview).toMatchObject({ kind: 'scene', publishable: false });
    expect(proposal.preview.renderJobId).toBeUndefined();
    expect(await tdb.db.select().from(renderPreviews)).toEqual([]);
  });

  it('with creative.preview_render off (the default) previewRender queues nothing: an older worker-render never sees a preview job', async () => {
    const events = await tdb.db.select().from(outboxEvents);
    const proposal = await propose({ formatKeys: ['square_1080'] });
    expect(proposal.preview).toMatchObject({ kind: 'scene', publishable: false });
    expect(proposal.preview.renderJobId).toBeUndefined();
    expect(await tdb.db.select().from(renderJobs)).toEqual([]);
    expect(await tdb.db.select().from(renderPreviews)).toEqual([]);
    expect(await tdb.db.select().from(outboxEvents)).toEqual(events); // no creative.render_requested
  });

  it('a preview render draws the proposed snapshot to exports marked non-publishable; nothing is committed', async () => {
    // Enabled for this tenant once every worker-render is preview-aware (docs/runbooks/deploy-railway.md).
    await tdb.db.insert(featureFlags).values({
      key: 'creative.preview_render',
      enabledDefault: false,
      targeting: { tenantIds: [tenantA] },
      owner: 'creative',
      removalDate: new Date('2027-03-31T00:00:00Z'),
      successMetric: 'test',
    });
    const proposal = await propose({ formatKeys: ['square_1080'] });
    const renderJobId = proposal.preview.renderJobId as string;
    expect(renderJobId).toMatch(/^rj_/);
    const result = await runRenderJob(acts, inputFor(renderJobId));
    expect(result.outcome).toBe('ready');

    const job = await read(() => creativeService.renders.get(A, { renderJobId }));
    expect(job).toMatchObject({
      state: 'ready',
      revisionId: baseRevisionId,
      preview: { contentHash: proposal.contentHash, baseRevisionId },
    });
    expect(job.exports).toHaveLength(1);
    const [exp] = job.exports;
    expect(exp).toMatchObject({ publishable: false, pageId: 'page_1', formatKey: 'square_1080' });
    expect(exp!.id).toMatch(/^pvx_/);
    expect(exp!.storageKey).toContain(`/previews/${renderJobId}/`);
    expect(exp!.manifest.revisionContentHash).toBe(proposal.contentHash); // the proposed snapshot, not the base
    const bytes = await read(() => mem.getObject(exp!.storageKey));
    expect(sha256(bytes!)).toBe(exp!.contentHash);

    // Nothing was committed and nothing publishable exists: no revision, no rendered export.
    expect(await tdb.db.select().from(creativeRevisions)).toHaveLength(1);
    expect(await tdb.db.select().from(renderedExports)).toEqual([]);
    expect(await tdb.db.select().from(previewExports)).toHaveLength(1);
    // The exports a channel variant or a release can resolve do not include it (spec 14.5 publish media source).
    await expect(read(() => creativeService.renders.exportsByIds(brandA, [exp!.id]))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // The committed-revision path is unchanged: a rendered, publishable export of the base revision.
    const committed = await run((tx) =>
      creativeService.renders.request(
        A,
        { documentId, revisionId: baseRevisionId, formatKeys: ['square_1080'] },
        tx,
      ),
    );
    expect((await runRenderJob(acts, inputFor(committed.renderJobId))).outcome).toBe('ready');
    const base = await read(() => creativeService.renders.get(A, { renderJobId: committed.renderJobId }));
    expect(base.preview).toBeNull();
    expect(base.exports[0]).toMatchObject({ publishable: true, revisionId: baseRevisionId });
    expect(base.exports[0]!.id).toMatch(/^exp_/);
    expect(base.exports[0]!.storageKey).toContain(`/exports/${baseRevisionId}/`);
    expect(base.exports[0]!.contentHash).not.toBe(exp!.contentHash); // the preview drew the moved block
    expect(
      await read(() => creativeService.renders.exportsByIds(brandA, [base.exports[0]!.id])),
    ).toHaveLength(1);
  });
});
