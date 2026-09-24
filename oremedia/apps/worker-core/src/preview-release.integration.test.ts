import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  defaultPolicyDocument,
  emptyBrandSystemDocument,
  type BrandSystemDocumentV1,
} from '@oremedia/contracts/brand';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { PublicationForRelease } from '@oremedia/contracts/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { channelVariants } from '@oremedia/db/schema/content';
import { featureFlags } from '@oremedia/db/schema/operations';
import { brandService } from '@oremedia/module-brand';
import { contentService, registerChannelResolver } from '@oremedia/module-content';
import { creativeService } from '@oremedia/module-creative';
import { evaluateRelease, registerReleaseCheckers, reviewService } from '@oremedia/module-review';
import { composeModules } from './composition';

/**
 * Ledger 3.10, the safety half: a preview export (operations.propose with previewRender) can never be selected for a
 * channel variant, bound into an approval or released. Against MySQL with the worker-core composition and the real
 * content, review and creative modules: the committed revision's export goes through variant, approval and release;
 * the preview export of a proposal against the same revision is refused at each of those points.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
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

const blockId = `el_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const bgId = `el_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const studioDocument = (brandVersionId: string): CreativeDocumentV1 => ({
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
          id: bgId,
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
          id: blockId,
          name: 'Block',
          type: 'shape',
          locked: false,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 80, y: 80, width: 400, height: 400, rotation: 0 },
          shape: 'rect',
          fillToken: 'ink',
          strokeWidth: 0,
          cornerRadius: 0,
        },
      ],
    },
  ],
});

/** What the render worker reports for one page (the worker path itself is proven in apps/worker-render). */
const renderedPage = (tenantId: string, brandVersionId: string, hashChar: string) => ({
  pageId: 'page_1',
  formatKey: 'square_1080',
  mime: 'image/png',
  width: 1080,
  height: 1080,
  bytes: 1234,
  storageKey: `assets/${tenantId}/r/${hashChar}.png`,
  contentHash: hashChar.repeat(64),
  rendererVersion: 'renderer-test',
  manifest: {
    rendererVersion: 'renderer-test',
    fonts: [],
    assets: [],
    brandVersionId,
    revisionContentHash: 'd'.repeat(64),
  },
  validation: { ok: true, findings: [] },
});

describe('a preview export is never bound or released (ledger 3.10)', () => {
  let tdb: TestDatabase;
  const tenantId = newId('ten');
  const brandId = newId('brd');
  const channelId = newId('cc');
  const userId = newId('usr');
  const membershipId = newId('mem');
  const manager: ResolvedActor = {
    kind: 'user',
    id: userId,
    tenantId,
    membershipId,
    membershipStatus: 'active',
    role: 'brand_manager',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  };
  const ctx: TenantContext = {
    tenantId,
    actor: { kind: 'user', id: userId },
    brandIds: 'all',
    correlationId: 'corr_preview_release',
  };
  const run = <T>(fn: (tx: Tx) => Promise<T>) => runInTenant(ctx, () => withTransaction(fn));
  const at = new Date('2026-06-01T09:00:00.000Z');
  const timing = { kind: 'exact' as const, at: at.toISOString() };
  let brandVersionId = '';
  let exportId = '';
  let previewExportId = '';
  let contentRevisionId = '';
  let contentPackageId = '';
  let variantId = '';

  /** A job the worker picked up and completed with one page (renders.markRendering → markReady). */
  async function complete(renderJobId: string, hashChar: string): Promise<string> {
    await run((tx) => creativeService.renders.markRendering({ renderJobId }, tx));
    const ready = await run((tx) =>
      creativeService.renders.markReady(
        { renderJobId, exports: [renderedPage(tenantId, brandVersionId, hashChar)] },
        tx,
      ),
    );
    return ready.exportIds[0]!;
  }
  const pubFor = (approvalId: string): PublicationForRelease => ({
    id: 'pub_preview',
    tenantId,
    brandId,
    contentPackageId,
    contentRevisionId,
    channelVariantId: variantId,
    channelConnectionId: channelId,
    authority: 'approval',
    approvalId,
    mandateId: null,
    scheduledFor: at.toISOString(),
    state: 'scheduled',
  });
  const setExports = (exportIds: string[]) =>
    tdb.db.update(channelVariants).set({ exportIds }).where(eq(channelVariants.id, variantId));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    composeModules();
    // Hooks the tests stand in for: one known channel, permissive channel checks (not what is under test here).
    registerChannelResolver(async (id) =>
      id === channelId ? { brandId, providerKey: 'fixture_provider', capabilityVersion: 1 } : null,
    );
    registerReleaseCheckers({
      channelUsable: async () => true,
      validateVariant: async () => true,
      countForMandateOnDay: async () => 0,
      publishedElsewhereForApprovalChannel: async () => false,
    });
    await tdb.db
      .insert(tenants)
      .values({ id: tenantId, name: 'P', slug: `pr-${tenantId.slice(-10).toLowerCase()}` });
    await tdb.db
      .insert(users)
      .values({ id: userId, email: `${userId.toLowerCase()}@example.test`, name: 'M' });
    await tdb.db.insert(memberships).values({
      id: membershipId,
      tenantId,
      userId,
      role: 'brand_manager',
      status: 'active',
      allBrands: true,
    });
    await tdb.db
      .insert(brands)
      .values({ id: brandId, tenantId, name: 'P1', timezone: 'UTC', defaultLocale: 'en', status: 'active' });
    // Preview renders are behind creative.preview_render (default off, rolling-deploy guard); on for this tenant.
    await tdb.db.insert(featureFlags).values({
      key: 'creative.preview_render',
      enabledDefault: false,
      targeting: { tenantIds: [tenantId] },
      owner: 'creative',
      removalDate: new Date('2027-03-31T00:00:00Z'),
      successMetric: 'test',
    });
    const draft = await run((tx) => brandService.versions.createDraft(manager, { brandId }, tx));
    brandVersionId = draft.versionId;
    await run((tx) =>
      brandService.versions.update(
        manager,
        { brandId, versionId: brandVersionId, expectedVersion: 0, document: brandDocument() },
        tx,
      ),
    );
    await run((tx) =>
      brandService.versions.submitForReview(
        manager,
        { brandId, versionId: brandVersionId, expectedVersion: 1 },
        tx,
      ),
    );
    await run((tx) =>
      brandService.versions.publish(manager, { brandId, versionId: brandVersionId, expectedVersion: 2 }, tx),
    );
    const pv = await run((tx) =>
      brandService.policy.createVersion(manager, { brandId, document: defaultPolicyDocument() }, tx),
    );
    await run((tx) =>
      brandService.policy.activate(
        manager,
        { brandId, policyVersionId: pv.policyVersionId, expectedVersion: 0 },
        tx,
      ),
    );

    const doc = await run((tx) =>
      creativeService.documents.create(
        manager,
        { brandId, title: 'Offer', document: studioDocument(brandVersionId) },
        tx,
      ),
    );
    const committed = await run((tx) =>
      creativeService.renders.request(
        manager,
        { documentId: doc.documentId, revisionId: doc.revisionId, formatKeys: ['square_1080'] },
        tx,
      ),
    );
    exportId = await complete(committed.renderJobId, 'a');
    const proposal = await run((tx) =>
      creativeService.operations.propose(
        manager,
        {
          documentId: doc.documentId,
          baseRevisionId: doc.revisionId,
          operations: [{ op: 'moveElement', pageId: 'page_1', elementId: blockId, x: 600, y: 600 }],
          summary: 'move the block',
          origin: 'user',
          previewRender: { formatKeys: ['square_1080'] },
        },
        tx,
      ),
    );
    previewExportId = await complete(proposal.preview.renderJobId as string, 'e');

    const pkg = await run((tx) =>
      contentService.packages.create(
        manager,
        {
          brandId,
          title: 'Offer',
          copy: { schemaVersion: 1, master: { text: 'Offer caption', factRefs: [] } },
          creativeDocumentIds: [doc.documentId],
        },
        tx,
      ),
    );
    contentPackageId = pkg.contentPackageId;
    contentRevisionId = pkg.contentRevisionId;
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('channel variants pick the revision’s rendered exports only; selecting a preview export is refused', async () => {
    expect(previewExportId).toMatch(/^pvx_/);
    const gen = await run((tx) =>
      contentService.variants.generate(manager, { contentRevisionId, channelConnectionIds: [channelId] }, tx),
    );
    variantId = gen.created[0]!;
    const variant = await run((tx) => contentService.variants.read(variantId, tx));
    expect(variant.exportIds).toEqual([exportId]);
    await expect(
      run((tx) =>
        contentService.variants.update(
          manager,
          {
            channelVariantId: variantId,
            expectedVersion: variant.version,
            text: variant.text,
            altTexts: variant.altTexts,
            settings: variant.settings,
            exportIds: [previewExportId],
          },
          tx,
        ),
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ValidationFailedError && e.details?.some((d) => d.issue === 'export_not_found') === true,
    );
  });

  it('a variant carrying a preview export cannot be bound into an approval', async () => {
    await setExports([previewExportId]); // as if it had been written around the module
    await expect(
      run((tx) =>
        reviewService.requests.create(manager, { contentRevisionId, assigneeUserIds: [], timing }, tx),
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await setExports([exportId]);
  });

  it('the approved release of the committed export evaluates; substituting the preview export can never be released', async () => {
    const req = await run((tx) =>
      reviewService.requests.create(manager, { contentRevisionId, assigneeUserIds: [], timing }, tx),
    );
    const decided = await run((tx) =>
      reviewService.decisions.submit(
        manager,
        { reviewRequestId: req.reviewRequestId, decision: 'approve', expectedManifestHash: req.manifestHash },
        tx,
      ),
    );
    const approvalId = decided.approvalId!;
    expect(await runInTenant(ctx, () => evaluateRelease(pubFor(approvalId), at))).toEqual({ allow: true });
    await setExports([previewExportId]);
    await expect(runInTenant(ctx, () => evaluateRelease(pubFor(approvalId), at))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // And the publish media source (what dispatch uploads) never resolves it either.
    await expect(
      runInTenant(ctx, () => creativeService.renders.exportsByIds(brandId, [previewExportId])),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await setExports([exportId]);
  });
});
