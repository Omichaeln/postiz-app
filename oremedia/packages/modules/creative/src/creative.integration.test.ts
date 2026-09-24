import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Element, OperationsApply } from '@oremedia/contracts/creative';
import {
  NotFoundError,
  PolicyDeniedError,
  RightsIneligibleError,
  StaleRevisionError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import {
  creativeDocuments,
  creativeRevisions,
  elementComments,
  renderJobs,
  renderedExports,
} from '@oremedia/db/schema/creative';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { hashCanonical } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import { brandService } from '@oremedia/module-brand';
import {
  creativeService,
  registerAssetAuthoriser,
  registerRevisionChangeHook,
  resetAssetAuthoriser,
} from './service';

const USER = 'usr_creative_test';
const AGENT = 'sp_creative_test';
const ctx = (tenantId: string, brandIds: ReadonlySet<string> | 'all' = 'all'): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds,
  correlationId: 'corr_creative',
});
const manager = (tenantId: string): ResolvedActor => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_creative_test',
  membershipStatus: 'active',
  role: 'brand_manager',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const agent = (tenantId: string): ResolvedActor => ({
  kind: 'service_principal',
  id: AGENT,
  tenantId,
  status: 'active',
  maxAutonomy: 'create',
  grants: [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'brand.edit_standards', brandIds: 'all' },
    { action: 'creative.read', brandIds: 'all' },
    { action: 'creative.edit', brandIds: 'all' },
    { action: 'creative.render', brandIds: 'all' },
  ],
});
/** The agent runtime supplies the run's autonomy mode (spec 5.5 step 7); create is what editing needs. */
const AGENT_OPTS = { autonomyMode: 'create' as const };

/** Runs a command the way the router does: tenant context + one transaction. */
const run = <T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  brandIds: ReadonlySet<string> | 'all' = 'all',
) => runInTenant(ctx(tenantId, brandIds), () => withTransaction(fn));

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  voice: {
    ...emptyBrandSystemDocument().voice,
    summary: 'Plain',
    tone: ['plain'],
    prohibitedPhrases: ['cheap'],
  },
  tokens: {
    colours: [
      { key: 'ink', value: '#172120', role: 'text' },
      { key: 'paper', value: '#F4F6F3', role: 'background' },
      { key: 'accent', value: '#0F6E63', role: 'accent' },
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

const ids = { bg: newElementId(), headline: newElementId(), body: newElementId(), logo: newElementId() };

const text = (
  id: string,
  name: string,
  role: 'display' | 'body',
  t: string,
  y: number,
  h: number,
  sizePx: number,
): Element => ({
  id,
  name,
  type: 'text',
  locked: false,
  visible: true,
  opacity: 1,
  protected: false,
  transform: { x: 80, y, width: 920, height: h, rotation: 0 },
  text: t,
  style: {
    typeRole: role,
    fontAssetVersionId: 'av_font',
    weight: 600,
    sizePx,
    lineHeight: 1.2,
    tracking: 0,
    colourToken: 'ink',
    align: 'left',
    overflow: 'error',
  },
  factRefs: [],
});

/** A clean studio document: background, headline, body and a protected logo, all inside the safe area. */
const studioDocument = (brandVersionId: string, withLogo = true): CreativeDocumentV1 => ({
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
          id: ids.bg,
          name: 'Background',
          type: 'background',
          locked: true,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 0, y: 0, width: 1080, height: 1080, rotation: 0 },
          fillToken: 'paper',
        },
        text(ids.headline, 'Headline', 'display', 'October offer', 80, 120, 64),
        text(ids.body, 'Body', 'body', 'Twenty percent off in October', 760, 80, 24),
        ...(withLogo
          ? [
              {
                id: ids.logo,
                name: 'Logo',
                type: 'logo' as const,
                locked: false,
                visible: true,
                opacity: 1,
                protected: true,
                semanticRole: 'logo' as const,
                transform: { x: 80, y: 900, width: 200, height: 60, rotation: 0 },
                assetVersionId: 'av_logo',
                variant: 'primary' as const,
              },
            ]
          : []),
      ],
    },
  ],
  variants: [],
});

const image = (id: string, assetVersionId: string): Element => ({
  id,
  name: 'Image',
  type: 'image',
  locked: false,
  visible: true,
  opacity: 1,
  protected: false,
  transform: { x: 80, y: 260, width: 920, height: 460, rotation: 0 },
  assetVersionId,
  fit: 'cover',
});

const batch = (
  documentId: string,
  baseRevisionId: string,
  operations: OperationsApply['operations'],
  origin: 'user' | 'agent' = 'user',
  summary = 'edit',
): OperationsApply => ({ documentId, baseRevisionId, operations, summary, origin });

async function publishBrand(tenantId: string, brandId: string, document: BrandSystemDocumentV1) {
  const actor = manager(tenantId);
  const draft = await run(tenantId, (tx) => brandService.versions.createDraft(actor, { brandId }, tx));
  await run(tenantId, (tx) =>
    brandService.versions.update(
      actor,
      { brandId, versionId: draft.versionId, expectedVersion: 0, document },
      tx,
    ),
  );
  await run(tenantId, (tx) =>
    brandService.versions.submitForReview(
      actor,
      { brandId, versionId: draft.versionId, expectedVersion: 1 },
      tx,
    ),
  );
  await run(tenantId, (tx) =>
    brandService.versions.publish(actor, { brandId, versionId: draft.versionId, expectedVersion: 2 }, tx),
  );
  return draft.versionId;
}

describe('creative module (spec 11) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  const agentA = agent(tenantA);
  let brandVersionA = '';
  let brandVersionB = '';
  let docId = '';
  let rev1 = '';
  let rev2 = '';
  let rev3 = '';
  let docB = '';
  let revB = '';
  const authoriserCalls: Array<{
    assetVersionId: string;
    tenantId: string;
    brandId: string;
    purpose: string;
  }> = [];
  let authoriserMode: 'allow' | 'deny' = 'allow';
  const hookCalls: string[] = [];

  const revisionsOf = (documentId: string) =>
    tdb.db.select().from(creativeRevisions).where(eq(creativeRevisions.documentId, documentId));
  const documentRow = async (documentId: string) =>
    (await tdb.db.select().from(creativeDocuments).where(eq(creativeDocuments.id, documentId)))[0]!;
  const eventsOf = (tenantId: string, type: string) =>
    tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantId), eq(outboxEvents.eventType, type)));
  const head = () => run(tenantA, () => creativeService.documents.get(A, { documentId: docId }));
  const headlineOf = (doc: CreativeDocumentV1) => {
    const el = doc.pages[0]!.elements.find((e) => e.id === ids.headline);
    return el && el.type === 'text' ? el.text : null;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'creative-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'creative-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'setup' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    brandVersionA = await publishBrand(tenantA, brandA, brandDocument());
    brandVersionB = await publishBrand(tenantB, brandB, brandDocument());
    registerRevisionChangeHook(async (documentId) => {
      hookCalls.push(documentId);
    });
    // Tenant B has a document of its own for the foreign-id checks; its text fonts need an authoriser, which is
    // reset afterwards so the "fails loudly when unregistered" check below still sees the module default.
    registerAssetAuthoriser(async () => undefined);
    const created = await run(tenantB, (tx) =>
      creativeService.documents.create(
        manager(tenantB),
        { brandId: brandB, title: 'B doc', document: studioDocument(brandVersionB, false) },
        tx,
      ),
    );
    docB = created.documentId;
    revB = created.revisionId;
    resetAssetAuthoriser();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  describe('asset authorisation hook (spec 11.4 guardAssets)', () => {
    it('fails loudly when no authoriser is registered, so a composition mistake cannot pass silently', async () => {
      await expect(
        run(tenantA, (tx) =>
          creativeService.documents.create(
            A,
            { brandId: brandA, title: 'x', document: studioDocument(brandVersionA) },
            tx,
          ),
        ),
      ).rejects.toThrow(/asset authoriser not registered/);
      expect(
        (await tdb.db.select().from(creativeDocuments).where(eq(creativeDocuments.tenantId, tenantA))).length,
      ).toBe(0);
      registerAssetAuthoriser(async (assetVersionId, c) => {
        authoriserCalls.push({ assetVersionId, ...c });
        if (authoriserMode === 'deny') throw new RightsIneligibleError(assetVersionId, 'rights_unknown');
      });
    });
  });

  describe('documents and revisions (gate: save/reopen; spec 11.4)', () => {
    it('a brand without a published version cannot host a document', async () => {
      await expect(
        run(tenantA, (tx) => creativeService.documents.create(A, { brandId: brandA2, title: 'x' }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('create writes the document and revision 1 together, records the brand version and authorises the logo asset', async () => {
      const created = await run(tenantA, (tx) =>
        creativeService.documents.create(
          A,
          { brandId: brandA, title: 'October feed', document: studioDocument(brandVersionA) },
          tx,
        ),
      );
      docId = created.documentId;
      rev1 = created.revisionId;
      expect(created.number).toBe(1);
      expect(created.findings).toEqual([]);
      // Every referenced asset version is authorised for its purpose: the logo layer and the text font.
      expect(authoriserCalls).toHaveLength(2);
      expect(authoriserCalls).toEqual(
        expect.arrayContaining([
          { assetVersionId: 'av_logo', tenantId: tenantA, brandId: brandA, purpose: 'creative' },
          { assetVersionId: 'av_font', tenantId: tenantA, brandId: brandA, purpose: 'font' },
        ]),
      );
      const got = await head();
      expect(got.currentRevisionId).toBe(rev1);
      expect(got.version).toBe(1);
      expect(got.revision.number).toBe(1);
      expect(got.revision.parentRevisionId).toBeNull();
      expect(got.revision.brandVersionId).toBe(brandVersionA);
      expect(got.revision.authorKind).toBe('user');
      expect(got.revision.snapshot).toEqual(studioDocument(brandVersionA));
      expect(got.revision.contentHash).toBe(hashCanonical(studioDocument(brandVersionA)));
      expect(got.revision.operations.operations.map((o) => o.op)).toEqual(['addPage']);
      const minimal = await run(tenantA, (tx) =>
        creativeService.documents.create(A, { brandId: brandA, title: 'Blank' }, tx),
      );
      const blank = await run(tenantA, () =>
        creativeService.documents.get(A, { documentId: minimal.documentId }),
      );
      expect(blank.revision.snapshot.pages[0]!.elements).toEqual([]);
      expect(blank.revision.snapshot.brandVersionId).toBe(brandVersionA);
    });

    it('apply commits a new revision; documents.get returns the committed snapshot (save/reopen)', async () => {
      const result = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          batch(docId, rev1, [
            { op: 'setText', pageId: 'page_1', elementId: ids.headline, text: 'Spring offer' },
          ]),
          tx,
        ),
      );
      rev2 = result.revision.id;
      expect(result.revision.number).toBe(2);
      expect(result.revision.parentRevisionId).toBe(rev1);
      expect(result.findings).toEqual([]);
      expect(result.version).toBe(2);
      const got = await head();
      expect(got.currentRevisionId).toBe(rev2);
      expect(headlineOf(got.revision.snapshot)).toBe('Spring offer');
      expect(got.revision.contentHash).toBe(hashCanonical(got.revision.snapshot));
      expect(hookCalls).toEqual([docId]);
      const events = await eventsOf(tenantA, 'creative.revision_created');
      expect(events.map((e) => e.payload)).toContainEqual(
        expect.objectContaining({ documentId: docId, revisionId: rev2, brandId: brandA, number: 2 }),
      );
    });

    it('a second apply against the old base is STALE_REVISION (409) carrying the current head, and succeeds after rebasing', async () => {
      const stale = batch(docId, rev1, [
        { op: 'moveElement', pageId: 'page_1', elementId: ids.body, x: 80, y: 770 },
      ]);
      const err = await run(tenantA, (tx) => creativeService.operations.apply(A, stale, tx)).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(StaleRevisionError);
      expect((err as StaleRevisionError).currentRevisionId).toBe(rev2);
      expect((err as StaleRevisionError).httpStatus).toBe(409);
      expect((await revisionsOf(docId)).length).toBe(2);
      const rebased = await run(tenantA, (tx) =>
        creativeService.operations.apply(A, { ...stale, baseRevisionId: rev2 }, tx),
      );
      rev3 = rebased.revision.id;
      expect(rebased.revision.number).toBe(3);
      expect(rebased.revision.parentRevisionId).toBe(rev2);
    });

    it('undo is a new revision whose content hash equals the earlier one; history is never rewritten', async () => {
      const undone = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          batch(docId, rev3, [{ op: 'moveElement', pageId: 'page_1', elementId: ids.body, x: 80, y: 760 }]),
          tx,
        ),
      );
      expect(undone.revision.number).toBe(4);
      const two = await run(tenantA, () =>
        creativeService.revisions.get(A, { documentId: docId, revisionId: rev2 }),
      );
      expect(undone.revision.contentHash).toBe(two.contentHash);
      expect(undone.revision.snapshot).toEqual(two.snapshot);
      const list = await run(tenantA, () =>
        creativeService.revisions.list(A, { documentId: docId, page: { limit: 50 } }),
      );
      expect(list.items.map((r) => r.number)).toEqual([4, 3, 2, 1]);
      expect(list.items.map((r) => r.id)).toEqual([undone.revision.id, rev3, rev2, rev1]);
      expect(list.items.every((r) => !('snapshot' in r))).toBe(true);
      const paged = await run(tenantA, () =>
        creativeService.revisions.list(A, { documentId: docId, page: { limit: 3 } }),
      );
      expect(paged.nextCursor).not.toBeNull();
      const rest = await run(tenantA, () =>
        creativeService.revisions.list(A, {
          documentId: docId,
          page: { limit: 3, cursor: paged.nextCursor! },
        }),
      );
      expect(rest.items.map((r) => r.id)).toEqual([rev1]);
      const rows = await revisionsOf(docId);
      expect(rows.map((r) => r.number).sort()).toEqual([1, 2, 3, 4]);
      expect(rows.every((r) => r.brandVersionId === brandVersionA)).toBe(true); // every revision records the brand version
      expect(rows.find((r) => r.number === 1)!.parentRevisionId).toBeNull();
    });

    it('a structurally invalid operation is VALIDATION_FAILED, not a crash, and writes nothing', async () => {
      const before = (await revisionsOf(docId)).length;
      const current = (await head()).currentRevisionId!;
      await expect(
        run(tenantA, (tx) =>
          creativeService.operations.apply(
            A,
            batch(docId, current, [{ op: 'setText', pageId: 'page_9', elementId: ids.headline, text: 'x' }]),
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'operations.0', issue: 'page_not_found' }],
      });
      expect((await revisionsOf(docId)).length).toBe(before);
    });
  });

  describe('agent guards (gate: protected elements immune; spec 11.4)', () => {
    it('an agent batch touching a protected element is denied with protected_element and writes nothing', async () => {
      const before = (await revisionsOf(docId)).length;
      const current = (await head()).currentRevisionId!;
      await expect(
        run(tenantA, (tx) =>
          creativeService.operations.apply(
            agentA,
            batch(
              docId,
              current,
              [{ op: 'moveElement', pageId: 'page_1', elementId: ids.logo, x: 0, y: 0 }],
              'agent',
            ),
            tx,
            AGENT_OPTS,
          ),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'protected_element' });
      // The same batch labelled as a person's is refused: an agent cannot escape the guards by lying about origin.
      await expect(
        run(tenantA, (tx) =>
          creativeService.operations.apply(
            agentA,
            batch(
              docId,
              current,
              [{ op: 'moveElement', pageId: 'page_1', elementId: ids.logo, x: 0, y: 0 }],
              'user',
            ),
            tx,
            AGENT_OPTS,
          ),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'origin_mismatch' });
      // Without the run's autonomy mode (the API path) an agent cannot edit at all.
      await expect(
        run(tenantA, (tx) =>
          creativeService.operations.apply(
            agentA,
            batch(
              docId,
              current,
              [{ op: 'setText', pageId: 'page_1', elementId: ids.body, text: 'x' }],
              'agent',
            ),
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      expect((await revisionsOf(docId)).length).toBe(before);
      expect((await documentRow(docId)).currentRevisionId).toBe(current);
    });

    it('agents cannot insert logo elements', async () => {
      const current = (await head()).currentRevisionId!;
      const logo: Element = {
        id: newElementId(),
        name: 'Fake logo',
        type: 'logo',
        locked: false,
        visible: true,
        opacity: 1,
        protected: false,
        transform: { x: 400, y: 900, width: 200, height: 60, rotation: 0 },
        assetVersionId: 'av_logo',
        variant: 'primary',
      };
      await expect(
        run(tenantA, (tx) =>
          creativeService.operations.apply(
            agentA,
            batch(docId, current, [{ op: 'insertElement', pageId: 'page_1', element: logo }], 'agent'),
            tx,
            AGENT_OPTS,
          ),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'agent_logo_insert' });
      expect((await documentRow(docId)).currentRevisionId).toBe(current);
    });

    it('a blocking finding rejects an agent batch with nothing written; the same batch from a person commits with the findings', async () => {
      const current = (await head()).currentRevisionId!;
      const before = (await revisionsOf(docId)).length;
      const ops: OperationsApply['operations'] = [
        { op: 'setText', pageId: 'page_1', elementId: ids.body, text: 'A cheap deal for October' },
      ];
      const err = await run(tenantA, (tx) =>
        creativeService.operations.apply(agentA, batch(docId, current, ops, 'agent'), tx, AGENT_OPTS),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationFailedError);
      expect((err as ValidationFailedError).details?.[0]?.issue).toMatch(/^prohibited_phrase/);
      expect((await revisionsOf(docId)).length).toBe(before);
      // propose returns the findings instead of throwing, for the studio overlay and the agent run to decide.
      const proposal = await run(tenantA, (tx) =>
        creativeService.operations.propose(agentA, batch(docId, current, ops, 'agent'), tx, AGENT_OPTS),
      );
      expect(proposal.blocking).toBe(true);
      expect(proposal.findings.map((f) => f.code)).toContain('prohibited_phrase');
      expect(proposal.changedElementIds).toEqual([ids.body]);
      expect(proposal.snapshot.pages[0]!.elements.find((e) => e.id === ids.body)).toMatchObject({
        text: 'A cheap deal for October',
      });
      expect((await revisionsOf(docId)).length).toBe(before);
      const committed = await run(tenantA, (tx) =>
        creativeService.operations.apply(A, batch(docId, current, ops, 'user'), tx),
      );
      expect(committed.findings.map((f) => f.code)).toContain('prohibited_phrase');
      expect(committed.revision.contentHash).toBe(proposal.contentHash);
      expect((await revisionsOf(docId)).length).toBe(before + 1);
      // A person accepting an agent proposal commits it with origin agent: the revision records the agent as author kind.
      const accepted = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          {
            ...batch(
              docId,
              committed.revision.id,
              [
                {
                  op: 'setText',
                  pageId: 'page_1',
                  elementId: ids.body,
                  text: 'Twenty percent off in October',
                },
              ],
              'agent',
            ),
            agentRunId: 'run_test',
          },
          tx,
        ),
      );
      expect(accepted.revision.authorKind).toBe('agent');
      expect(accepted.revision.authorId).toBe(USER);
      expect(accepted.revision.agentRunId).toBe('run_test');
    });

    it('an agent-clean batch commits from an agent with the run id recorded', async () => {
      const current = (await head()).currentRevisionId!;
      const result = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          agentA,
          {
            ...batch(
              docId,
              current,
              [{ op: 'setText', pageId: 'page_1', elementId: ids.headline, text: 'Autumn offer' }],
              'agent',
            ),
            agentRunId: 'run_agent',
          },
          tx,
          AGENT_OPTS,
        ),
      );
      expect(result.revision.authorKind).toBe('agent');
      expect(result.revision.authorId).toBe(AGENT);
      expect(result.revision.agentRunId).toBe('run_agent');
      expect(result.findings).toEqual([]);
    });
  });

  describe('asset authorisation (spec 11.4 guardAssets)', () => {
    it('replaceAsset and image inserts call the registered authoriser with the asset version id', async () => {
      authoriserCalls.length = 0;
      const current = (await head()).currentRevisionId!;
      const imageId = newElementId();
      await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          batch(docId, current, [
            { op: 'replaceAsset', pageId: 'page_1', elementId: ids.logo, assetVersionId: 'av_logo_2' },
            { op: 'insertElement', pageId: 'page_1', element: image(imageId, 'av_photo') },
          ]),
          tx,
        ),
      );
      expect(authoriserCalls).toEqual([
        { assetVersionId: 'av_logo_2', tenantId: tenantA, brandId: brandA, purpose: 'creative' },
        { assetVersionId: 'av_photo', tenantId: tenantA, brandId: brandA, purpose: 'creative' },
      ]);
      const got = await head();
      expect(got.revision.snapshot.pages[0]!.elements.find((e) => e.id === ids.logo)).toMatchObject({
        assetVersionId: 'av_logo_2',
      });
      // Tidy up: remove the image again so later layout checks stay simple.
      await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          batch(docId, got.currentRevisionId!, [
            { op: 'removeElement', pageId: 'page_1', elementId: imageId },
          ]),
          tx,
        ),
      );
    });

    it('RIGHTS_INELIGIBLE from the authoriser aborts the apply with nothing written', async () => {
      authoriserMode = 'deny';
      const current = (await head()).currentRevisionId!;
      const before = (await revisionsOf(docId)).length;
      const beforeComments = JSON.stringify(
        await tdb.db.select().from(elementComments).where(eq(elementComments.documentId, docId)),
      );
      try {
        await expect(
          run(tenantA, (tx) =>
            creativeService.operations.apply(
              A,
              batch(docId, current, [
                { op: 'insertElement', pageId: 'page_1', element: image(newElementId(), 'av_bad') },
              ]),
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(RightsIneligibleError);
        await expect(
          run(tenantA, (tx) =>
            creativeService.documents.create(
              A,
              { brandId: brandA, title: 'x', document: studioDocument(brandVersionA) },
              tx,
            ),
          ),
        ).rejects.toBeInstanceOf(RightsIneligibleError);
      } finally {
        authoriserMode = 'allow';
      }
      expect((await revisionsOf(docId)).length).toBe(before);
      expect((await documentRow(docId)).currentRevisionId).toBe(current);
      expect(
        JSON.stringify(
          await tdb.db.select().from(elementComments).where(eq(elementComments.documentId, docId)),
        ),
      ).toBe(beforeComments);
    });
  });

  describe('comments (spec 11.4 markOutdatedFor, 21.4)', () => {
    let onHeadline = '';
    let onBody = '';

    it('comments anchor on an element of a revision; an unknown element is rejected', async () => {
      const current = (await head()).currentRevisionId!;
      onHeadline = (
        await run(tenantA, (tx) =>
          creativeService.comments.add(
            A,
            { documentId: docId, revisionId: current, elementId: ids.headline, body: 'Shorter?' },
            tx,
          ),
        )
      ).commentId;
      onBody = (
        await run(tenantA, (tx) =>
          creativeService.comments.add(
            agentA,
            { documentId: docId, revisionId: current, elementId: ids.body, body: 'Consider a fact ref' },
            tx,
            AGENT_OPTS,
          ),
        )
      ).commentId;
      await expect(
        run(tenantA, (tx) =>
          creativeService.comments.add(
            A,
            { documentId: docId, revisionId: current, elementId: newElementId(), body: 'x' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const list = await run(tenantA, () =>
        creativeService.comments.list(A, { documentId: docId, page: { limit: 50 } }),
      );
      expect(list.items.map((c) => c.id)).toEqual([onBody, onHeadline]);
      expect(list.items.find((c) => c.id === onBody)!.authorKind).toBe('agent');
    });

    it('an open comment becomes outdated when its element changes; untouched comments stay open', async () => {
      const current = (await head()).currentRevisionId!;
      const result = await run(tenantA, (tx) =>
        creativeService.operations.apply(
          A,
          batch(docId, current, [
            { op: 'setText', pageId: 'page_1', elementId: ids.headline, text: 'Winter offer' },
          ]),
          tx,
        ),
      );
      expect(result.outdatedComments).toBe(1);
      const rows = await tdb.db.select().from(elementComments).where(eq(elementComments.documentId, docId));
      expect(rows.find((c) => c.id === onHeadline)).toMatchObject({ state: 'outdated', version: 1 });
      expect(rows.find((c) => c.id === onBody)).toMatchObject({ state: 'open', version: 0 });
      const open = await run(tenantA, () =>
        creativeService.comments.list(A, { documentId: docId, state: 'open', page: { limit: 50 } }),
      );
      expect(open.items.map((c) => c.id)).toEqual([onBody]);
    });

    it('resolve moves a comment to resolved once; a wrong version is CONFLICT', async () => {
      await expect(
        run(tenantA, (tx) =>
          creativeService.comments.resolve(
            A,
            { documentId: docId, commentId: onBody, expectedVersion: 3 },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const resolved = await run(tenantA, (tx) =>
        creativeService.comments.resolve(A, { documentId: docId, commentId: onBody, expectedVersion: 0 }, tx),
      );
      expect(resolved).toEqual({ commentId: onBody, state: 'resolved', version: 1 });
      await expect(
        run(tenantA, (tx) =>
          creativeService.comments.resolve(
            A,
            { documentId: docId, commentId: onBody, expectedVersion: 1 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      // An outdated comment can still be resolved (the person acknowledges it).
      const ack = await run(tenantA, (tx) =>
        creativeService.comments.resolve(
          A,
          { documentId: docId, commentId: onHeadline, expectedVersion: 1 },
          tx,
        ),
      );
      expect(ack.state).toBe('resolved');
    });
  });

  describe('renders (spec 11.5, 13.1 render job machine)', () => {
    let jobId = '';
    let revisionId = '';

    it('request creates a pending job and an outbox event; unknown formats are rejected', async () => {
      revisionId = (await head()).currentRevisionId!;
      await expect(
        run(tenantA, (tx) =>
          creativeService.renders.request(A, { documentId: docId, revisionId, formatKeys: ['nope_1x1'] }, tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const requested = await run(tenantA, (tx) =>
        creativeService.renders.request(
          A,
          { documentId: docId, revisionId, formatKeys: ['square_1080', 'ig_feed_4x5', 'square_1080'] },
          tx,
        ),
      );
      jobId = requested.renderJobId;
      expect(requested.state).toBe('pending');
      const job = await run(tenantA, () => creativeService.renders.get(A, { renderJobId: jobId }));
      expect(job).toMatchObject({
        state: 'pending',
        attempts: 0,
        formatKeys: ['square_1080', 'ig_feed_4x5'],
        requestedByKind: 'user',
        exportIds: [],
        exports: [],
      });
      const events = await eventsOf(tenantA, 'creative.render_requested');
      expect(events.length).toBe(1);
      expect(events[0]!.payload).toMatchObject({
        renderJobId: jobId,
        revisionId,
        brandId: brandA,
        formatKeys: 'square_1080,ig_feed_4x5',
      });
      // A revision of another document cannot be rendered through this document.
      await expect(
        run(tenantA, (tx) =>
          creativeService.renders.request(
            A,
            { documentId: docId, revisionId: revB, formatKeys: ['square_1080'] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('the worker moves the job only through the machine; ready inserts the exports; illegal moves are rejected', async () => {
      // ready before rendering is illegal.
      await expect(
        run(tenantA, (tx) =>
          creativeService.renders.markReady(
            { renderJobId: jobId, exports: [exportFor('square_1080', 1080, 1080)] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const rendering = await run(tenantA, (tx) =>
        creativeService.renders.markRendering({ renderJobId: jobId }, tx),
      );
      expect(rendering).toMatchObject({ state: 'rendering', attempts: 1, version: 1 });
      // An export for a format that was not requested is refused before anything is written.
      await expect(
        run(tenantA, (tx) =>
          creativeService.renders.markReady(
            { renderJobId: jobId, exports: [exportFor('x_1600x900', 1600, 900)] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(
        (await tdb.db.select().from(renderedExports).where(eq(renderedExports.revisionId, revisionId)))
          .length,
      ).toBe(0);
      const ready = await run(tenantA, (tx) =>
        creativeService.renders.markReady(
          {
            renderJobId: jobId,
            exports: [exportFor('square_1080', 1080, 1080), exportFor('ig_feed_4x5', 1080, 1350)],
          },
          tx,
        ),
      );
      expect(ready.state).toBe('ready');
      expect(ready.exportIds.length).toBe(2);
      const job = await run(tenantA, () => creativeService.renders.get(A, { renderJobId: jobId }));
      expect(job.state).toBe('ready');
      expect(job.exportIds).toEqual(ready.exportIds);
      expect(job.exports.map((e) => e.formatKey)).toEqual(['square_1080', 'ig_feed_4x5']);
      expect(job.exports[0]).toMatchObject({
        revisionId,
        storageKey: `renders/${tenantA}/square_1080.png`,
        contentHash: 'a'.repeat(64),
        manifest: { brandVersionId: brandVersionA },
      });
      expect('url' in job.exports[0]!).toBe(false);
      const rows = await tdb.db
        .select()
        .from(renderedExports)
        .where(eq(renderedExports.revisionId, revisionId));
      expect(rows.length).toBe(2);
      expect((await eventsOf(tenantA, 'creative.render_completed'))[0]!.payload).toMatchObject({
        renderJobId: jobId,
        state: 'ready',
        exportCount: 2,
      });
      // ready is terminal: neither start nor fail is legal, and the row is untouched.
      await expect(
        run(tenantA, (tx) => creativeService.renders.markRendering({ renderJobId: jobId }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(
        run(tenantA, (tx) => creativeService.renders.markFailed({ renderJobId: jobId, error: 'boom' }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect((await tdb.db.select().from(renderJobs).where(eq(renderJobs.id, jobId)))[0]).toMatchObject({
        state: 'ready',
        version: 2,
        error: null,
      });
      // A failing render records the error and can be retried from failed (pending → rendering → failed).
      const second = await run(tenantA, (tx) =>
        creativeService.renders.request(
          A,
          { documentId: docId, revisionId, formatKeys: ['square_1080'] },
          tx,
        ),
      );
      await run(tenantA, (tx) =>
        creativeService.renders.markRendering({ renderJobId: second.renderJobId }, tx),
      );
      const failed = await run(tenantA, (tx) =>
        creativeService.renders.markFailed({ renderJobId: second.renderJobId, error: 'font missing' }, tx),
      );
      expect(failed.state).toBe('failed');
      expect(
        (await run(tenantA, () => creativeService.renders.get(A, { renderJobId: second.renderJobId }))).error,
      ).toBe('font missing');
    });

    const exportFor = (formatKey: string, width: number, height: number) => ({
      pageId: 'page_1',
      formatKey,
      mime: 'image/png',
      width,
      height,
      bytes: 1234,
      storageKey: `renders/${tenantA}/${formatKey}.png`,
      contentHash: 'a'.repeat(64),
      rendererVersion: 'renderer-test',
      manifest: {
        rendererVersion: 'renderer-test',
        fonts: [{ assetVersionId: 'av_font', contentHash: 'b'.repeat(64) }],
        assets: [{ assetVersionId: 'av_logo_2', contentHash: 'c'.repeat(64) }],
        brandVersionId: brandVersionA,
        revisionContentHash: 'd'.repeat(64),
      },
      validation: { ok: true, findings: [] },
    });
  });

  describe('templates (spec 6.3, 11.3 applyTemplate)', () => {
    let templateId = '';
    let templateVersionId = '';
    const slotHeadline = newElementId();
    const templateDoc = (): CreativeDocumentV1 => ({
      ...studioDocument(brandVersionA, false),
      pages: [
        {
          ...studioDocument(brandVersionA, false).pages[0]!,
          elements: [
            studioDocument(brandVersionA, false).pages[0]!.elements[0]!,
            text(slotHeadline, 'Template headline', 'display', 'Template', 80, 120, 64),
          ],
        },
      ],
    });

    it('create, createVersion (validated slots and formats), list and get', async () => {
      templateId = (
        await run(tenantA, (tx) =>
          creativeService.templates.create(A, { brandId: brandA, name: 'Offer' }, tx),
        )
      ).templateId;
      await expect(
        run(tenantA, (tx) =>
          creativeService.templates.createVersion(
            A,
            {
              templateId,
              document: templateDoc(),
              slots: [{ key: 'headline', elementId: newElementId(), kind: 'text', required: true }],
              constraints: {},
              formats: ['nope'],
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [
          { path: 'slots.0.elementId', issue: 'element_not_in_document' },
          { path: 'formats.0', issue: 'unknown format nope' },
        ],
      });
      const version = await run(tenantA, (tx) =>
        creativeService.templates.createVersion(
          A,
          {
            templateId,
            document: templateDoc(),
            slots: [{ key: 'headline', elementId: slotHeadline, kind: 'text', required: true }],
            constraints: {},
            formats: ['square_1080'],
          },
          tx,
        ),
      );
      templateVersionId = version.templateVersionId;
      expect(version).toMatchObject({ number: 1, state: 'draft', contentHash: hashCanonical(templateDoc()) });
      const list = await run(tenantA, () =>
        creativeService.templates.list(A, { brandId: brandA, page: { limit: 50 } }),
      );
      expect(list.items.map((t) => t.id)).toEqual([templateId]);
      const got = await run(tenantA, () => creativeService.templates.get(A, { templateId }));
      expect(got.state).toBe('draft');
      expect(got.currentVersionId).toBeNull();
      expect(got.selectedVersion).toBeNull();
      expect(got.versions.map((v) => v.number)).toEqual([1]);
      expect('document' in got.versions[0]!).toBe(false);
    });

    it('applyTemplate with an unapproved version is rejected; an agent cannot approve; approval activates the template', async () => {
      const current = (await head()).currentRevisionId!;
      const apply = (origin: 'user' | 'agent' = 'user') =>
        batch(
          docId,
          current,
          [
            {
              op: 'applyTemplate',
              pageId: 'page_1',
              templateVersionId,
              slotBindings: { headline: ids.headline },
            },
          ],
          origin,
        );
      await expect(
        run(tenantA, (tx) => creativeService.operations.apply(A, apply(), tx)),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'operations.0.templateVersionId', issue: 'template_version_not_approved' }],
      });
      await expect(
        run(tenantA, (tx) =>
          creativeService.templates.approve(
            agentA,
            { templateId, templateVersionId, expectedVersion: 0 },
            tx,
            AGENT_OPTS,
          ),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'propose_only' });
      const approved = await run(tenantA, (tx) =>
        creativeService.templates.approve(A, { templateId, templateVersionId, expectedVersion: 0 }, tx),
      );
      expect(approved).toMatchObject({ state: 'approved', templateState: 'active', version: 1 });
      await expect(
        run(tenantA, (tx) =>
          creativeService.templates.approve(A, { templateId, templateVersionId, expectedVersion: 1 }, tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const got = await run(tenantA, () => creativeService.templates.get(A, { templateId }));
      expect(got).toMatchObject({ state: 'active', currentVersionId: templateVersionId, version: 1 });
      expect(got.selectedVersion).toMatchObject({ state: 'approved', document: templateDoc() });
      const applied = await run(tenantA, (tx) => creativeService.operations.apply(A, apply(), tx));
      expect(applied.revision.snapshot.templateVersionId).toBe(templateVersionId);
      const elements = applied.revision.snapshot.pages[0]!.elements;
      // The bound slot keeps the document's element id and text; the rest of the page comes from the template.
      expect(elements.map((e) => e.id)).toEqual([ids.bg, ids.headline]);
      expect(elements[1]).toMatchObject({ type: 'text', text: 'Winter offer', name: 'Template headline' });
      // A template version of another brand's template is NOT_FOUND even through a visible document.
      const other = await run(tenantB, (tx) =>
        creativeService.templates.create(manager(tenantB), { brandId: brandB, name: 'B' }, tx),
      );
      await expect(
        run(tenantA, () => creativeService.templates.get(A, { templateId: other.templateId })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('tenancy (spec 5.3, 19.3) and concurrency (spec 11.4)', () => {
    it('foreign-tenant document, revision, comment, template and render ids are NOT_FOUND with nothing written', async () => {
      const before = JSON.stringify({
        revisions: await revisionsOf(docB),
        doc: await documentRow(docB),
        comments: await tdb.db.select().from(elementComments).where(eq(elementComments.tenantId, tenantB)),
        jobs: await tdb.db.select().from(renderJobs).where(eq(renderJobs.tenantId, tenantB)),
      });
      const commentB = (
        await run(tenantB, (tx) =>
          creativeService.comments.add(
            manager(tenantB),
            { documentId: docB, revisionId: revB, elementId: ids.headline, body: 'b' },
            tx,
          ),
        )
      ).commentId;
      await expect(
        run(tenantA, () => creativeService.documents.get(A, { documentId: docB })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, () => creativeService.revisions.get(A, { documentId: docB, revisionId: revB })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, () => creativeService.revisions.get(A, { documentId: docId, revisionId: revB })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          creativeService.operations.apply(
            A,
            batch(docB, revB, [{ op: 'setText', pageId: 'page_1', elementId: ids.headline, text: 'x' }]),
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          creativeService.comments.resolve(
            A,
            { documentId: docB, commentId: commentB, expectedVersion: 0 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          creativeService.comments.resolve(
            A,
            { documentId: docId, commentId: commentB, expectedVersion: 0 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          creativeService.renders.request(
            A,
            { documentId: docB, revisionId: revB, formatKeys: ['square_1080'] },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) => creativeService.documents.create(A, { brandId: brandB, title: 'x' }, tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
      // A restricted actor (brand A2 only) cannot see brand A1's document.
      await expect(
        runInTenant(ctx(tenantA, new Set([brandA2])), () =>
          creativeService.documents.get(A, { documentId: docId }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(
        JSON.stringify({
          revisions: await revisionsOf(docB),
          doc: await documentRow(docB),
          comments: (
            await tdb.db.select().from(elementComments).where(eq(elementComments.tenantId, tenantB))
          ).filter((c) => c.id !== commentB),
          jobs: await tdb.db.select().from(renderJobs).where(eq(renderJobs.tenantId, tenantB)),
        }),
      ).toBe(before);
      // Tenant B still reaches its own rows.
      expect(
        (await run(tenantB, () => creativeService.documents.get(manager(tenantB), { documentId: docB }))).id,
      ).toBe(docB);
    });

    it('two concurrent applies against the same head: exactly one commits, the other is STALE_REVISION (409)', async () => {
      const current = (await head()).currentRevisionId!;
      const before = (await revisionsOf(docId)).length;
      const attempt = (text: string) =>
        run(tenantA, (tx) =>
          creativeService.operations.apply(
            A,
            batch(docId, current, [{ op: 'setText', pageId: 'page_1', elementId: ids.headline, text }]),
            tx,
          ),
        );
      const results = await Promise.allSettled([attempt('First'), attempt('Second')]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      const err = (rejected[0] as PromiseRejectedResult).reason as StaleRevisionError;
      expect(err).toBeInstanceOf(StaleRevisionError);
      expect(err.httpStatus).toBe(409);
      const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof attempt>>>).value;
      expect(err.currentRevisionId).toBe(winner.revision.id);
      expect((await revisionsOf(docId)).length).toBe(before + 1);
      expect((await documentRow(docId)).currentRevisionId).toBe(winner.revision.id);
    });

    it('every mutation left an allowed audit event in the command transaction', async () => {
      const rows = await tdb.db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantA));
      const actions = new Set(rows.filter((r) => r.decision === 'allowed').map((r) => r.action));
      for (const a of [
        'creative.document.create',
        'creative.operations.apply',
        'creative.render.request',
        'creative.render.start',
        'creative.render.ready',
        'creative.render.fail',
        'creative.comment.add',
        'creative.comment.resolve',
        'creative.template.create',
        'creative.template.create_version',
        'creative.template.approve',
      ])
        expect(actions.has(a), a).toBe(true);
      expect(rows.every((r) => r.correlationId === 'corr_creative')).toBe(true);
      const denied = rows.filter((r) => r.decision === 'denied' && r.actorId === AGENT);
      expect(denied.length).toBeGreaterThan(0);
    });
  });
});
