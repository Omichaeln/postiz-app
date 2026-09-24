import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Observability from '@oremedia/observability';
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
import { renderJobs, renderedExports } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createRenderJobActivities, type FormatRenderer } from '@oremedia/activities';
import { RENDERER_VERSION } from '@oremedia/editor/renderer/version';
import { MemoryStorageProvider, assetService, configureStorage } from '@oremedia/module-assets';
import { creativeService, registerAssetAuthoriser } from '@oremedia/module-creative';
import { METRIC, count, record } from '@oremedia/observability';
import { runRenderJob } from '@oremedia/workflows/render-job.workflow.v1';
import { creativeRenderJobStore } from './creative-store';

vi.mock('@oremedia/observability', async (importOriginal) => {
  const actual = await importOriginal<typeof Observability>();
  return { ...actual, count: vi.fn(actual.count), record: vi.fn(actual.record) };
});

/**
 * Runbook "recover rendering" (docs/runbooks/recover-rendering.md, spec 17.7, ledger 7.9) walked through the real
 * creative module, the real render-job activities and the renderJobWorkflowV1 orchestration (runRenderJob) against
 * MySQL, with a scripted renderer standing in for Chromium (the path that crashes is the renderer call): a
 * renderer failure fails the job with `render_failed: <detail>` (step 2) and counts oremedia.render.failures; the
 * retry is a new job for the same revision (step 3) whose export lands under its own job key while the failed
 * job and its (absent) exports stay untouched; a duplicate start of a finished job is harmless (illegal_state).
 */
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newId = (kind: IdKind): string =>
  `${ID_PREFIXES[kind]}_${[...randomBytes(26)].map((b) => CROCKFORD[b % 32]).join('')}`;
const hashCanonical = (value: unknown) => sha256(Buffer.from(JSON.stringify(value)));

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
    ],
    typeRoles: [],
    spacingScale: [4, 8],
    radii: [0],
    contrastTarget: 'AA',
  },
});

/** A one-page document with a background only: no fonts or assets to resolve, so the renderer is the only risk. */
const plainDocument = (brandVersionId: string): CreativeDocumentV1 => ({
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
          id: newId('element'),
          name: 'Background',
          type: 'background',
          locked: true,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 0, y: 0, width: 1080, height: 1080, rotation: 0 },
          fillToken: 'paper',
        },
      ],
    },
  ],
});

/** The Chromium stand-in: scripted to crash (memory, timeout) or return deterministic bytes. */
class ScriptedRenderer implements FormatRenderer {
  next: 'crash' | 'ok' = 'ok';
  async render(input: Parameters<FormatRenderer['render']>[0]) {
    if (this.next === 'crash') throw new Error('Target closed: chromium exited (out of memory)');
    return {
      png: Buffer.from(`png:${input.page.id}:${input.formatKey}`),
      width: 1080,
      height: 1080,
      findings: [],
    };
  }
}

describe('runbook: recover rendering (worker-render activities, scripted renderer)', () => {
  let tdb: TestDatabase;
  const mem = new MemoryStorageProvider();
  const tenantA = newId('tenant');
  const brandA = newId('brand');
  const ownerA = newId('user');
  const actor: ResolvedActor = {
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
    correlationId: 'corr_recover_render',
  };
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx, () => withTransaction(fn));
  const renderer = new ScriptedRenderer();
  const acts = createRenderJobActivities({
    store: creativeRenderJobStore(),
    renderer,
    rendererVersion: RENDERER_VERSION,
    storage: mem,
  });
  const inputFor = (renderJobId: string): RenderJobInputV1 => ({
    tenantId: tenantA,
    actor: { kind: 'user', id: ownerA },
    correlationId: 'corr_recover_render',
    renderJobId,
  });
  const jobRow = async (id: string) =>
    (await tdb.db.select().from(renderJobs).where(eq(renderJobs.id, id)))[0]!;
  let brandVersionId = '';

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureStorage(mem);
    registerAssetAuthoriser(async (assetVersionId, c, tx) => {
      await assetService.authoriseUse(assetVersionId, c.purpose, { brandId: c.brandId }, tx);
    });
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: `recover-${tenantA.slice(-6).toLowerCase()}` });
    await tdb.db
      .insert(users)
      .values({ id: ownerA, email: `${ownerA.toLowerCase()}@example.test`, name: 'owner' });
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
    brandVersionId = newId('brandVersion');
    const document = brandDocument();
    await tdb.db.insert(brandVersions).values({
      id: brandVersionId,
      tenantId: tenantA,
      brandId: brandA,
      number: 1,
      state: 'published',
      document,
      contentHash: hashCanonical(document),
      publishedAt: new Date(),
      publishedByUserId: ownerA,
    });
    await tdb.db.update(brands).set({ publishedVersionId: brandVersionId }).where(eq(brands.id, brandA));
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('a renderer crash fails the job as render_failed with the detail; the retry is a new job; exports are never overwritten', async () => {
    const created = await run((tx) =>
      creativeService.documents.create(
        actor,
        { brandId: brandA, title: 'Feed', document: plainDocument(brandVersionId) },
        tx,
      ),
    );
    const first = await run((tx) =>
      creativeService.renders.request(
        actor,
        { documentId: created.documentId, revisionId: created.revisionId, formatKeys: ['square_1080'] },
        tx,
      ),
    );

    // Symptom: the job fails; step 2 reads `error` as `<reason>: <detail>`.
    renderer.next = 'crash';
    expect(await runRenderJob(acts, inputFor(first.renderJobId))).toEqual({
      outcome: 'failed',
      reason: 'render_failed',
    });
    const failed = await jobRow(first.renderJobId);
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/^render_failed: .*chromium exited/);
    expect(vi.mocked(count)).toHaveBeenCalledWith(METRIC.renderFailures, 1, { reason: 'render_failed' });
    expect(vi.mocked(count)).toHaveBeenCalledWith(METRIC.renderJobs, 1, { result: 'failed' });
    expect(mem.keys().filter((k) => k.includes(`/${first.renderJobId}/`))).toEqual([]);

    // Step 3: re-request the revision: a new job, rendered once the renderer is healthy again.
    renderer.next = 'ok';
    const retry = await run((tx) =>
      creativeService.renders.request(
        actor,
        { documentId: created.documentId, revisionId: created.revisionId, formatKeys: ['square_1080'] },
        tx,
      ),
    );
    expect(retry.renderJobId).not.toBe(first.renderJobId);
    const ok = await runRenderJob(acts, inputFor(retry.renderJobId));
    expect(ok.outcome).toBe('ready');
    const exports = await tdb.db
      .select()
      .from(renderedExports)
      .where(eq(renderedExports.revisionId, created.revisionId));
    expect(exports).toHaveLength(1);
    expect(
      exports[0]!.storageKey.startsWith(
        `assets/${tenantA}/${brandA}/exports/${created.revisionId}/${retry.renderJobId}/`,
      ),
    ).toBe(true);
    expect(vi.mocked(record)).toHaveBeenCalledWith(METRIC.renderDurationMs, expect.any(Number), {
      formatKey: 'square_1080',
    });
    expect(vi.mocked(count)).toHaveBeenCalledWith(METRIC.renderJobs, 1, { result: 'ready' });
    expect(vi.mocked(record)).toHaveBeenCalledWith(METRIC.renderStartLagMs, expect.any(Number));
    // The failed job is untouched by the retry (its row is the record of the incident).
    expect(await jobRow(first.renderJobId)).toMatchObject({ state: 'failed', version: failed.version });

    // A duplicate start of the finished job (Temporal retry after a worker crash) changes nothing (illegal_state).
    const before = await jobRow(retry.renderJobId);
    const duplicate = await runRenderJob(acts, inputFor(retry.renderJobId));
    expect(duplicate).toEqual({ outcome: 'failed', reason: 'illegal_state' });
    expect(await jobRow(retry.renderJobId)).toMatchObject({ state: 'ready', version: before.version });
    expect(
      await tdb.db.select().from(renderedExports).where(eq(renderedExports.revisionId, created.revisionId)),
    ).toHaveLength(1);
  });
});
