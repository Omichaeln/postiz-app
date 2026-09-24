import { ApprovalBindingV1 } from '@oremedia/contracts/approval';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  defaultPolicyDocument,
  emptyBrandSystemDocument,
  type BrandSystemDocumentV1,
} from '@oremedia/contracts/brand';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import {
  NotFoundError,
  PolicyDeniedError,
  RightsIneligibleError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActor, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { PublicationForRelease } from '@oremedia/contracts/publishing';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import {
  externalReviewerLinks,
  memberships,
  servicePrincipals,
  tenants,
  users,
} from '@oremedia/db/schema/access';
import { entitlements } from '@oremedia/db/schema/billing';
import { brands } from '@oremedia/db/schema/brand';
import { channelVariants, contentRevisions } from '@oremedia/db/schema/content';
import { auditEvents, featureFlags, outboxEvents } from '@oremedia/db/schema/operations';
import { releaseApprovals, reviewDecisions, reviewRequests } from '@oremedia/db/schema/review';
import { bindingHash } from '@oremedia/domain/approval-binding';
import { hashCanonical } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import { authenticate, resolveTenantContext } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import {
  contentService,
  registerChannelResolver,
  registerRevisionChangeListener,
} from '@oremedia/module-content';
import {
  creativeService,
  registerAssetAuthoriser as registerCreativeAssetAuthoriser,
  registerRevisionChangeHook,
} from '@oremedia/module-creative';
import { killSwitch } from '@oremedia/module-operations';
import {
  buildLiveBinding,
  evaluateRelease,
  registerAssetAuthoriser,
  registerReleaseCheckers,
  resetReleaseCheckers,
  type ReleaseCheckers,
} from './evaluate-release';
import { reviewService } from './service';
import { reviewToolSource } from './tools';

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

const ids = { bg: newElementId(), headline: newElementId() };
const studioDocument = (brandVersionId: string, headline = 'October offer'): CreativeDocumentV1 => ({
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
        {
          id: ids.headline,
          name: 'Headline',
          type: 'text',
          locked: false,
          visible: true,
          opacity: 1,
          protected: false,
          transform: { x: 80, y: 80, width: 920, height: 120, rotation: 0 },
          text: headline,
          style: {
            typeRole: 'display',
            fontAssetVersionId: 'av_font',
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
      ],
    },
  ],
  variants: [],
});

const exportFor = (tenantId: string, brandVersionId: string, hashChar: string) => ({
  pageId: 'page_1',
  formatKey: 'square_1080',
  mime: 'image/png',
  width: 1080,
  height: 1080,
  bytes: 1234,
  storageKey: `renders/${tenantId}/${hashChar}.png`,
  contentHash: hashChar.repeat(64),
  rendererVersion: 'renderer-test',
  manifest: {
    rendererVersion: 'renderer-test',
    fonts: [{ assetVersionId: 'av_font', contentHash: 'b'.repeat(64) }],
    assets: [{ assetVersionId: 'av_photo', contentHash: 'c'.repeat(64) }],
    brandVersionId,
    revisionContentHash: 'd'.repeat(64),
  },
  validation: { ok: true, findings: [] },
});

interface Person {
  id: string;
  membershipId: string;
  actor: ResolvedActor;
}

describe('review module (spec 13) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const channelA = newId('channelConnection');
  const channelA2 = newId('channelConnection');
  const channelB = newId('channelConnection');
  let manager: Person;
  let reviewer: Person;
  let managerB: Person;
  let brandVersionA = '';
  let policyVersionA = '';
  let docId = '';
  let docRevision = '';
  let exportIds: string[] = [];
  let packageId = '';
  let revisionId = '';
  let variantId = '';
  let factId = '';
  // Foreign rows (tenant B) for the NOT_FOUND checks.
  let requestB = '';
  let approvalB = '';
  const authorised = { assets: true };
  const checks = { channelUsable: true, validateVariant: true, count: 0, publishedElsewhere: false };

  const ctx = (tenantId: string, actorId: string): TenantContext => ({
    tenantId,
    actor: { kind: 'user', id: actorId },
    brandIds: 'all',
    correlationId: 'corr_review',
  });
  const run = <T>(tenantId: string, actorId: string, fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx(tenantId, actorId), () => withTransaction(fn));
  const runA = <T>(fn: (tx: Tx) => Promise<T>) => run(tenantA, manager.id, fn);
  const eventsOf = (tenantId: string, type: string) =>
    tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantId), eq(outboxEvents.eventType, type)));
  const auditOf = (tenantId: string, action: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, action)));
  const approvalRow = async (id: string) =>
    (await tdb.db.select().from(releaseApprovals).where(eq(releaseApprovals.id, id)))[0]!;
  const requestRow = async (id: string) =>
    (await tdb.db.select().from(reviewRequests).where(eq(reviewRequests.id, id)))[0]!;
  const variantRow = async (id: string) =>
    (await tdb.db.select().from(channelVariants).where(eq(channelVariants.id, id)))[0]!;
  const setVariant = (id: string, values: Partial<typeof channelVariants.$inferInsert>) =>
    tdb.db.update(channelVariants).set(values).where(eq(channelVariants.id, id));

  async function person(
    tenantId: string,
    label: string,
    role: 'brand_manager' | 'reviewer',
  ): Promise<Person> {
    const id = newId('user');
    const membershipId = newId('membership');
    await tdb.db
      .insert(users)
      .values({ id, email: `${label}-${id.slice(-6).toLowerCase()}@example.test`, name: label });
    await tdb.db
      .insert(memberships)
      .values({ id: membershipId, tenantId, userId: id, role, status: 'active', allBrands: true });
    return {
      id,
      membershipId,
      actor: {
        kind: 'user',
        id,
        tenantId,
        membershipId,
        membershipStatus: 'active',
        role,
        allBrands: true,
        brandGrants: [],
        mfaEnrolled: false,
      },
    };
  }

  async function publishBrand(tenantId: string, brandId: string, actor: ResolvedActor) {
    const draft = await run(tenantId, actor.id, (tx) =>
      brandService.versions.createDraft(actor, { brandId }, tx),
    );
    await run(tenantId, actor.id, (tx) =>
      brandService.versions.update(
        actor,
        { brandId, versionId: draft.versionId, expectedVersion: 0, document: brandDocument() },
        tx,
      ),
    );
    await run(tenantId, actor.id, (tx) =>
      brandService.versions.submitForReview(
        actor,
        { brandId, versionId: draft.versionId, expectedVersion: 1 },
        tx,
      ),
    );
    await run(tenantId, actor.id, (tx) =>
      brandService.versions.publish(actor, { brandId, versionId: draft.versionId, expectedVersion: 2 }, tx),
    );
    return draft.versionId;
  }
  async function activatePolicy(tenantId: string, brandId: string, actor: ResolvedActor) {
    const pv = await run(tenantId, actor.id, (tx) =>
      brandService.policy.createVersion(
        actor,
        {
          brandId,
          document: defaultPolicyDocument(),
        },
        tx,
      ),
    );
    await run(tenantId, actor.id, (tx) =>
      brandService.policy.activate(
        actor,
        { brandId, policyVersionId: pv.policyVersionId, expectedVersion: 0 },
        tx,
      ),
    );
    return pv.policyVersionId;
  }
  /** A creative document with a ready export (as the creative tests do), returned with its ids. */
  async function readyDocument(
    tenantId: string,
    brandId: string,
    brandVersionId: string,
    actor: ResolvedActor,
    hashChar = 'a',
  ) {
    const created = await run(tenantId, actor.id, (tx) =>
      creativeService.documents.create(
        actor,
        { brandId, title: 'Offer visual', document: studioDocument(brandVersionId) },
        tx,
      ),
    );
    const job = await run(tenantId, actor.id, (tx) =>
      creativeService.renders.request(
        actor,
        { documentId: created.documentId, revisionId: created.revisionId, formatKeys: ['square_1080'] },
        tx,
      ),
    );
    await run(tenantId, actor.id, (tx) =>
      creativeService.renders.markRendering({ renderJobId: job.renderJobId }, tx),
    );
    const ready = await run(tenantId, actor.id, (tx) =>
      creativeService.renders.markReady(
        { renderJobId: job.renderJobId, exports: [exportFor(tenantId, brandVersionId, hashChar)] },
        tx,
      ),
    );
    return { documentId: created.documentId, revisionId: created.revisionId, exportIds: ready.exportIds };
  }
  const pubFor = (over: Partial<PublicationForRelease> = {}): PublicationForRelease => ({
    id: 'preview',
    tenantId: tenantA,
    brandId: brandA,
    contentPackageId: packageId,
    contentRevisionId: revisionId,
    channelVariantId: variantId,
    channelConnectionId: channelA,
    authority: 'approval',
    approvalId: null,
    mandateId: null,
    scheduledFor: '2026-06-01T09:00:00.000Z',
    state: 'scheduled',
    ...over,
  });
  const at = new Date('2026-06-01T09:00:00.000Z');
  const timing = { kind: 'exact' as const, at: at.toISOString() };
  const requestFor = (contentRevisionId: string) => ({ contentRevisionId, assigneeUserIds: [], timing });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'review-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'review-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    manager = await person(tenantA, 'manager', 'brand_manager');
    reviewer = await person(tenantA, 'reviewer', 'reviewer');
    managerB = await person(tenantB, 'manager-b', 'brand_manager');
    // Hooks the composition root wires in production.
    registerCreativeAssetAuthoriser(async () => undefined);
    registerChannelResolver(async (id) => {
      const known: Record<string, { brandId: string }> = {
        [channelA]: { brandId: brandA },
        [channelA2]: { brandId: brandA },
        [channelB]: { brandId: brandB },
      };
      const c = known[id];
      return c ? { ...c, providerKey: 'fixture_provider', capabilityVersion: 1 } : null;
    });
    registerRevisionChangeListener((change, tx) => reviewService.onContentRevisionChange(change, tx));
    registerRevisionChangeHook((documentId, tx) =>
      reviewService.approvals.invalidateForCreativeRevisionChange(documentId, tx),
    );
    registerAssetAuthoriser(async (assetVersionId) => {
      if (!authorised.assets) throw new RightsIneligibleError(assetVersionId, 'rights_expired');
    });
    const checkers: ReleaseCheckers = {
      channelUsable: async () => checks.channelUsable,
      validateVariant: async () => checks.validateVariant,
      countForMandateOnDay: async () => checks.count,
      publishedElsewhereForApprovalChannel: async () => checks.publishedElsewhere,
    };
    registerReleaseCheckers(checkers);

    brandVersionA = await publishBrand(tenantA, brandA, manager.actor);
    policyVersionA = await activatePolicy(tenantA, brandA, manager.actor);
    const fact = await runA((tx) =>
      brandService.facts.propose(
        manager.actor,
        {
          brandId: brandA,
          kind: 'offer',
          statement: '20% off in June',
          evidence: [{ kind: 'other', ref: 'test' }],
        },
        tx,
      ),
    );
    await runA((tx) =>
      brandService.facts.approve(
        manager.actor,
        { brandId: brandA, factId: fact.factId, expectedVersion: 0 },
        tx,
      ),
    );
    factId = fact.factId;
    const doc = await readyDocument(tenantA, brandA, brandVersionA, manager.actor);
    docId = doc.documentId;
    docRevision = doc.revisionId;
    exportIds = doc.exportIds;
    const pkg = await runA((tx) =>
      contentService.packages.create(
        manager.actor,
        {
          brandId: brandA,
          title: 'June offer',
          copy: { schemaVersion: 1, master: { text: 'Twenty percent off in June ', factRefs: [factId] } },
          creativeDocumentIds: [docId],
        },
        tx,
      ),
    );
    packageId = pkg.contentPackageId;
    revisionId = pkg.contentRevisionId;
    const gen = await runA((tx) =>
      contentService.variants.generate(
        manager.actor,
        { contentRevisionId: revisionId, channelConnectionIds: [channelA] },
        tx,
      ),
    );
    variantId = gen.created[0]!;

    // Tenant B: its own published brand, policy, package, request and approval for the foreign-id checks.
    const brandVersionB = await publishBrand(tenantB, brandB, managerB.actor);
    await activatePolicy(tenantB, brandB, managerB.actor);
    const docB = await readyDocument(tenantB, brandB, brandVersionB, managerB.actor, 'e');
    const pkgB = await run(tenantB, managerB.id, (tx) =>
      contentService.packages.create(
        managerB.actor,
        {
          brandId: brandB,
          title: 'B',
          copy: { schemaVersion: 1, master: { text: 'B caption', factRefs: [] } },
          creativeDocumentIds: [docB.documentId],
        },
        tx,
      ),
    );
    await run(tenantB, managerB.id, (tx) =>
      contentService.variants.generate(
        managerB.actor,
        { contentRevisionId: pkgB.contentRevisionId, channelConnectionIds: [channelB] },
        tx,
      ),
    );
    const reqB = await run(tenantB, managerB.id, (tx) =>
      reviewService.requests.create(managerB.actor, requestFor(pkgB.contentRevisionId), tx),
    );
    requestB = reqB.reviewRequestId;
    const decB = await run(tenantB, managerB.id, (tx) =>
      reviewService.decisions.submit(
        managerB.actor,
        { reviewRequestId: requestB, decision: 'approve', expectedManifestHash: reqB.manifestHash },
        tx,
      ),
    );
    approvalB = decB.approvalId!;
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  describe('review requests freeze a manifest (spec 13.3)', () => {
    let requestId = '';
    let manifestHash = '';

    it('freezes the manifest with its hash, moves the revision to in_review and emits review.requested', async () => {
      const res = await runA((tx) =>
        reviewService.requests.create(manager.actor, requestFor(revisionId), tx),
      );
      requestId = res.reviewRequestId;
      manifestHash = res.manifestHash;
      expect(res.revisionState).toBe('in_review');
      const full = await runA(() =>
        reviewService.requests.get(manager.actor, { reviewRequestId: requestId }),
      );
      expect(full.state).toBe('open');
      expect(full.frozenManifest).toMatchObject({
        v: 1,
        contentRevisionId: revisionId,
        creativeRevisionIds: [docRevision],
        exports: [{ exportId: exportIds[0], contentHash: 'a'.repeat(64), channelConnectionId: channelA }],
        captions: [{ channelConnectionId: channelA, text: 'Twenty percent off in June ' }],
        timing,
        brandVersionId: brandVersionA,
        policyVersionId: policyVersionA,
      });
      expect(hashCanonical(full.frozenManifest)).toBe(manifestHash);
      expect((await runA(() => contentService.revisions.read(revisionId))).state).toBe('in_review');
      expect((await eventsOf(tenantA, 'review.requested')).map((e) => e.payload)).toContainEqual(
        expect.objectContaining({ reviewRequestId: requestId, manifestHash }),
      );
      expect((await auditOf(tenantA, 'review.request.create')).length).toBe(1);
    });

    it('refuses a second open request on the same revision and a request on a revision without variants', async () => {
      await expect(
        runA((tx) => reviewService.requests.create(manager.actor, requestFor(revisionId), tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      const bare = await runA((tx) =>
        contentService.packages.create(
          manager.actor,
          {
            brandId: brandA,
            title: 'Bare',
            creativeDocumentIds: [],
            copy: { schemaVersion: 1, master: { text: 'no variants', factRefs: [] } },
          },
          tx,
        ),
      );
      await expect(
        runA((tx) => reviewService.requests.create(manager.actor, requestFor(bare.contentRevisionId), tx)),
      ).rejects.toMatchObject({ details: [{ issue: 'no_channel_variants' }] });
    });

    it('a decision on a different manifest hash is refused; a reject needs a reason', async () => {
      await expect(
        runA((tx) =>
          reviewService.decisions.submit(
            reviewer.actor,
            { reviewRequestId: requestId, decision: 'approve', expectedManifestHash: 'f'.repeat(64) },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ issue: 'manifest_hash_mismatch' }] });
      await expect(
        runA((tx) =>
          reviewService.decisions.submit(
            reviewer.actor,
            { reviewRequestId: requestId, decision: 'reject', expectedManifestHash: manifestHash },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ issue: 'reason_required' }] });
    });

    it('a package change after freezing marks the request stale with the reason and decisions are refused', async () => {
      const current = await runA(() =>
        contentService.packages.get(manager.actor, { contentPackageId: packageId }),
      );
      expect(current.state).toBe('in_review');
      const revised = await runA((tx) =>
        contentService.packages.revise(
          manager.actor,
          {
            contentPackageId: packageId,
            expectedVersion: current.version,
            copy: { schemaVersion: 1, master: { text: 'Twenty percent off in June', factRefs: [factId] } },
            creativeDocumentIds: [docId],
          },
          tx,
        ),
      );
      expect(revised.supersededRevisionId).toBe(revisionId);
      const stale = await requestRow(requestId);
      expect(stale.state).toBe('stale');
      expect(stale.staleReason).toBe('package_revised');
      const reviewerView = await runA(() =>
        reviewService.requests.get(reviewer.actor, { reviewRequestId: requestId }),
      );
      expect(reviewerView.staleReason).toBe('package_revised');
      await expect(
        runA((tx) =>
          reviewService.decisions.submit(
            reviewer.actor,
            { reviewRequestId: requestId, decision: 'approve', expectedManifestHash: manifestHash },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'resource_state' });
      expect((await eventsOf(tenantA, 'review.request_stale')).length).toBe(1);
      // The superseded revision is terminal; the package now points at revision 2 (draft).
      expect((await runA(() => contentService.revisions.read(revisionId))).state).toBe('superseded');
      revisionId = revised.contentRevisionId;
      const gen = await runA((tx) =>
        contentService.variants.generate(
          manager.actor,
          { contentRevisionId: revisionId, channelConnectionIds: [channelA] },
          tx,
        ),
      );
      variantId = gen.created[0]!;
    });
  });

  describe('decisions and approvals (spec 13.2)', () => {
    let requestId = '';
    let manifestHash = '';
    let approvalId = '';

    it('request_changes moves the revision to changes_requested and records an insert-only decision with hashed origin', async () => {
      const req = await runA((tx) =>
        reviewService.requests.create(manager.actor, requestFor(revisionId), tx),
      );
      const res = await runA((tx) =>
        reviewService.decisions.submit(
          reviewer.actor,
          {
            reviewRequestId: req.reviewRequestId,
            decision: 'request_changes',
            comment: 'Tighter headline',
            expectedManifestHash: req.manifestHash,
          },
          tx,
          { ipHash: 'ip'.repeat(32), userAgentHash: 'ua'.repeat(32) },
        ),
      );
      expect(res).toMatchObject({
        decision: 'request_changes',
        approvalId: null,
        requestState: 'decided',
        revisionState: 'changes_requested',
      });
      const rows = await tdb.db
        .select()
        .from(reviewDecisions)
        .where(eq(reviewDecisions.reviewRequestId, req.reviewRequestId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        deciderKind: 'user',
        deciderId: reviewer.id,
        ipHash: 'ip'.repeat(32),
        userAgentHash: 'ua'.repeat(32),
        verifiedEmail: null,
      });
      const inbox = await runA(() =>
        reviewService.inbox.list(manager.actor, { brandId: brandA, page: { limit: 50 } }),
      );
      expect(inbox.items.find((i) => i.id === req.reviewRequestId)?.attention).toEqual(['changes_requested']);
      expect((await eventsOf(tenantA, 'review.decided')).length).toBeGreaterThanOrEqual(1);
    });

    it('a re-request from changes_requested is approved: the approval binds the live rows by hash and the revision is approved', async () => {
      const req = await runA((tx) =>
        reviewService.requests.create(manager.actor, requestFor(revisionId), tx),
      );
      requestId = req.reviewRequestId;
      manifestHash = req.manifestHash;
      const res = await runA((tx) =>
        reviewService.decisions.submit(
          reviewer.actor,
          {
            reviewRequestId: requestId,
            decision: 'approve',
            expectedManifestHash: manifestHash,
            validUntil: '2026-07-01T00:00:00.000Z',
          },
          tx,
        ),
      );
      approvalId = res.approvalId!;
      expect(res.revisionState).toBe('approved');
      const apr = await approvalRow(approvalId);
      expect(apr.state).toBe('valid');
      expect(apr.approverId).toBe(reviewer.id);
      const live = await runA(() => buildLiveBinding(pubFor({ approvalId })));
      expect(apr.bindingHash).toBe(bindingHash(live.binding));
      expect(live.binding.targets).toHaveLength(1);
      expect(live.binding.targets[0]!.exportHashes).toEqual(['a'.repeat(64)]);
      expect(live.binding).toMatchObject({
        brandVersionId: brandVersionA,
        policyVersionId: policyVersionA,
        timing,
      });
      expect((await eventsOf(tenantA, 'approval.granted')).map((e) => e.payload)).toContainEqual(
        expect.objectContaining({ approvalId }),
      );
      expect(
        (await runA(() => contentService.packages.get(manager.actor, { contentPackageId: packageId }))).state,
      ).toBe('approved');
    });

    it('an approved revision can be released (Phase 5 gate)', async () => {
      const decision = await runA(() => evaluateRelease(pubFor({ approvalId }), at));
      expect(decision).toEqual({ allow: true });
    });

    it('any post-approval edit blocks dispatch: text, alt text, settings, a new export, a brand version change', async () => {
      const original = await variantRow(variantId);
      const expectMismatch = async () => {
        const d = await runA(() => evaluateRelease(pubFor({ approvalId }), at));
        expect(d).toMatchObject({ allow: false, hold: true });
        expect((d as { reasons: string[] }).reasons).toEqual(['approval_matches']);
      };
      await setVariant(variantId, { text: 'Twenty percent off in June!' });
      await expectMismatch();
      await setVariant(variantId, { text: original.text, altTexts: ['A different alt text'] });
      await expectMismatch();
      await setVariant(variantId, { altTexts: original.altTexts, settings: { firstComment: 'link' } });
      await expectMismatch();
      const extra = await readyDocument(tenantA, brandA, brandVersionA, manager.actor, 'f');
      await setVariant(variantId, {
        settings: original.settings,
        exportIds: [...original.exportIds, extra.exportIds[0]!],
      });
      await expectMismatch();
      await setVariant(variantId, { exportIds: original.exportIds });
      // Text normalisation: trailing whitespace and NFC do not change the bound hash.
      await setVariant(variantId, { text: `${original.text}   ` });
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toEqual({ allow: true });
      await setVariant(variantId, { text: original.text });
      // A new published brand version changes the live binding (eager hook aside).
      const newVersion = await publishBrand(tenantA, brandA, manager.actor);
      await expectMismatch();
      expect((await runA(() => brandService.get(manager.actor, brandA))).publishedVersionId).toBe(newVersion);
    });

    it('a revoked approver blocks dispatch (Phase 5 gate); a restored one does not resurrect a stale hash', async () => {
      // Re-approve against the new brand version so only the approver check is in play.
      const current = await runA(() =>
        contentService.packages.get(manager.actor, { contentPackageId: packageId }),
      );
      await runA((tx) =>
        contentService.packages.revise(
          manager.actor,
          {
            contentPackageId: packageId,
            expectedVersion: current.version,
            copy: { schemaVersion: 1, master: { text: 'Twenty percent off in June', factRefs: [factId] } },
            creativeDocumentIds: [docId],
          },
          tx,
        ),
      );
      const pkg = await runA(() =>
        contentService.packages.get(manager.actor, { contentPackageId: packageId }),
      );
      revisionId = pkg.revision.id;
      const gen = await runA((tx) =>
        contentService.variants.generate(
          manager.actor,
          { contentRevisionId: revisionId, channelConnectionIds: [channelA] },
          tx,
        ),
      );
      variantId = gen.created[0]!;
      const req = await runA((tx) =>
        reviewService.requests.create(manager.actor, requestFor(revisionId), tx),
      );
      requestId = req.reviewRequestId;
      const res = await runA((tx) =>
        reviewService.decisions.submit(
          reviewer.actor,
          { reviewRequestId: requestId, decision: 'approve', expectedManifestHash: req.manifestHash },
          tx,
        ),
      );
      approvalId = res.approvalId!;
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toEqual({ allow: true });
      await tdb.db
        .update(memberships)
        .set({ status: 'disabled' })
        .where(eq(memberships.id, reviewer.membershipId));
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toMatchObject({
        allow: false,
        reasons: ['approver_still_authorised'],
      });
      await tdb.db
        .update(memberships)
        .set({ role: 'analyst' })
        .where(eq(memberships.id, reviewer.membershipId));
      await tdb.db
        .update(memberships)
        .set({ status: 'active' })
        .where(eq(memberships.id, reviewer.membershipId));
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toMatchObject({
        allow: false,
        reasons: ['approver_still_authorised'],
      });
      await tdb.db
        .update(memberships)
        .set({ role: 'reviewer' })
        .where(eq(memberships.id, reviewer.membershipId));
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toEqual({ allow: true });
    });

    it('expired approvals, timing outside the binding, a dead channel, revoked rights, revoked facts and a failed capability each hold', async () => {
      await tdb.db
        .update(releaseApprovals)
        .set({ validUntil: new Date('2026-05-01T00:00:00Z') })
        .where(eq(releaseApprovals.id, approvalId));
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toMatchObject({
        reasons: ['approval_not_expired'],
      });
      await tdb.db
        .update(releaseApprovals)
        .set({ validUntil: null })
        .where(eq(releaseApprovals.id, approvalId));
      expect(
        await runA(() => evaluateRelease(pubFor({ approvalId }), new Date('2026-06-02T09:00:00Z'))),
      ).toMatchObject({
        reasons: ['timing_within_binding'],
      });
      checks.channelUsable = false;
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toMatchObject({
        reasons: ['channel_active'],
      });
      checks.channelUsable = true;
      authorised.assets = false;
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toMatchObject({
        reasons: ['assets_rights_valid'],
      });
      authorised.assets = true;
      checks.validateVariant = false;
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toMatchObject({
        reasons: ['capability_valid'],
      });
      checks.validateVariant = true;
      const fact = await runA(() =>
        brandService.facts.list(manager.actor, { brandId: brandA, page: { limit: 10 } }),
      );
      const row = fact.items.find((f) => f.id === factId)!;
      await runA((tx) =>
        brandService.facts.revoke(
          manager.actor,
          { brandId: brandA, factId, expectedVersion: row.version, reason: 'ended' },
          tx,
        ),
      );
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toMatchObject({
        reasons: ['facts_valid'],
      });
      // A missing or invalidated approval fails every approval check, never silently.
      expect(await runA(() => evaluateRelease(pubFor({ approvalId: approvalB }), at))).toMatchObject({
        reasons: [
          'approval_valid',
          'approval_matches',
          'approval_not_expired',
          'approver_still_authorised',
          'facts_valid',
        ],
      });
    });

    it('consume spends an approval once (valid → consumed, audited with the publication); a consumed approval fails approval_valid', async () => {
      const original = await approvalRow(approvalId);
      const spentId = newId('releaseApproval');
      await tdb.db.insert(releaseApprovals).values({ ...original, id: spentId, state: 'valid', version: 0 });
      const pubId = newId('publication');
      // a partial target set keeps the approval valid for the remaining channels (spec 13.2 binds every target)
      expect(await runA((tx) => reviewService.approvals.consume(spentId, tx, pubId, []))).toEqual({
        approvalId: spentId,
        state: 'valid',
        version: 0,
      });
      const targets = ApprovalBindingV1.parse(original.binding).targets.map((t) => t.channelConnectionId);
      expect(await runA((tx) => reviewService.approvals.consume(spentId, tx, pubId, targets))).toEqual({
        approvalId: spentId,
        state: 'consumed',
        version: 1,
      });
      expect((await approvalRow(spentId)).state).toBe('consumed');
      expect(
        (await auditOf(tenantA, 'review.approval.consume')).find((a) => a.resourceId === spentId)?.metadata,
      ).toMatchObject({ publicationId: pubId, fromState: 'valid', toState: 'consumed' });
      // a repeat (the publishing transaction retried) changes nothing
      expect(await runA((tx) => reviewService.approvals.consume(spentId, tx, pubId))).toEqual({
        approvalId: spentId,
        state: 'consumed',
        version: 1,
      });
      const d = await runA(() => evaluateRelease(pubFor({ approvalId: spentId }), at));
      expect(d).toMatchObject({ allow: false });
      expect((d as { reasons: string[] }).reasons).toContain('approval_valid');
      expect((await approvalRow(approvalId)).state).toBe('valid'); // the other approval is untouched
      // single use per target: a channel that already published under the approval fails approval_valid at dispatch
      checks.publishedElsewhere = true;
      try {
        const again = await runA(() => evaluateRelease(pubFor({ approvalId }), at));
        expect((again as { reasons: string[] }).reasons).toContain('approval_valid');
      } finally {
        checks.publishedElsewhere = false;
      }
    });

    it('the approval binding is validated on read: a malformed stored binding is refused, a valid one parses', async () => {
      const original = await approvalRow(approvalId);
      const brokenId = newId('releaseApproval');
      await tdb.db.insert(releaseApprovals).values({
        ...original,
        id: brokenId,
        binding: { v: 1 } as unknown as typeof original.binding,
      });
      await expect(runA((tx) => reviewService.approvals.getById(brokenId, tx))).rejects.toThrow();
      await tdb.db.delete(releaseApprovals).where(eq(releaseApprovals.id, brokenId)); // later reads list the request's approvals
      expect((await runA((tx) => reviewService.approvals.getById(approvalId, tx))).binding).toEqual(
        original.binding,
      );
    });

    it('a creative edit after approval invalidates the approval eagerly (spec 11.4 hook); the request is already decided', async () => {
      const before = await approvalRow(approvalId);
      expect(before.state).toBe('valid');
      await runA((tx) =>
        creativeService.operations.apply(
          manager.actor,
          {
            documentId: docId,
            baseRevisionId: docRevision,
            operations: [{ op: 'setLock', pageId: 'page_1', elementId: ids.headline, locked: true }],
            summary: 'lock',
            origin: 'user',
          },
          tx,
        ),
      );
      const after = await approvalRow(approvalId);
      expect(after.state).toBe('invalidated');
      expect(after.invalidatedReason).toBe('creative_revision_changed');
      expect((await eventsOf(tenantA, 'approval.invalidated')).map((e) => e.payload)).toContainEqual(
        expect.objectContaining({ approvalId }),
      );
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toMatchObject({ allow: false });
      const inbox = await runA(() => reviewService.inbox.list(manager.actor, { page: { limit: 50 } }));
      expect(inbox.items.find((i) => i.id === requestId)?.attention).toContain('approval_invalidated');
    });

    it('the release checkers fail loudly when unregistered, so a composition mistake cannot pass as allowed', async () => {
      resetReleaseCheckers();
      await expect(runA(() => evaluateRelease(pubFor({ approvalId }), at))).rejects.toThrow(
        /release checkers not registered/,
      );
      registerReleaseCheckers({
        channelUsable: async () => checks.channelUsable,
        validateVariant: async () => checks.validateVariant,
        countForMandateOnDay: async () => checks.count,
        publishedElsewhereForApprovalChannel: async () => checks.publishedElsewhere,
      });
    });
  });

  describe('external reviewers (spec 5.6)', () => {
    let requestId = '';
    let manifestHash = '';
    let linkId = '';
    let token = '';
    let external: ResolvedActor;

    const reviewerActor = async (bearer: string) => {
      const principal = await authenticate(bearer);
      if (!principal) throw new Error('token did not authenticate');
      return (await resolveTenantContext(principal, undefined, 'corr_external')).actor;
    };
    const asExternal = <T>(actor: ResolvedActor, fn: (tx: Tx) => Promise<T>) =>
      runInTenant(
        {
          tenantId: tenantA,
          actor: { kind: 'external_reviewer', id: actor.id },
          brandIds: new Set([brandA]),
          correlationId: 'corr_external',
        },
        () => withTransaction(fn),
      );

    it('a link is created for an open request, the token is returned once and authenticates as an external reviewer', async () => {
      const current = await runA(() =>
        contentService.packages.get(manager.actor, { contentPackageId: packageId }),
      );
      await runA((tx) =>
        contentService.packages.revise(
          manager.actor,
          {
            contentPackageId: packageId,
            expectedVersion: current.version,
            copy: { schemaVersion: 1, master: { text: 'June offer, no facts', factRefs: [] } },
            creativeDocumentIds: [],
          },
          tx,
        ),
      );
      const pkg = await runA(() =>
        contentService.packages.get(manager.actor, { contentPackageId: packageId }),
      );
      revisionId = pkg.revision.id;
      const gen = await runA((tx) =>
        contentService.variants.generate(
          manager.actor,
          { contentRevisionId: revisionId, channelConnectionIds: [channelA] },
          tx,
        ),
      );
      variantId = gen.created[0]!;
      const req = await runA((tx) =>
        reviewService.requests.create(manager.actor, requestFor(revisionId), tx),
      );
      requestId = req.reviewRequestId;
      manifestHash = req.manifestHash;
      const link = await runA((tx) =>
        reviewService.externalLinks.create(
          manager.actor,
          {
            reviewRequestId: requestId,
            email: 'Client@Example.test',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
          tx,
        ),
      );
      linkId = link.linkId;
      token = link.token;
      expect(token.startsWith('rl_')).toBe(true);
      external = await reviewerActor(token);
      expect(external).toMatchObject({
        kind: 'external_reviewer',
        reviewRequestId: requestId,
        brandId: brandA,
        revoked: false,
        expired: false,
      });
    });

    it('sees only the frozen manifest of their request; other requests and the inbox are out of scope', async () => {
      const view = await asExternal(external, () =>
        reviewService.requests.get(external, { reviewRequestId: requestId }),
      );
      expect(Object.keys(view).sort()).toEqual([
        'createdAt',
        'dueAt',
        'frozenManifest',
        'id',
        'manifestHash',
        'staleReason',
        'state',
      ]);
      expect(view.manifestHash).toBe(manifestHash);
      await expect(
        asExternal(external, () =>
          reviewService.inbox.list(external, { brandId: brandA, page: { limit: 10 } }),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('records the verified email on the decision, grants the approval to the link, and the link is single-use', async () => {
      const res = await asExternal(external, (tx) =>
        reviewService.decisions.submit(
          external,
          { reviewRequestId: requestId, decision: 'approve', expectedManifestHash: manifestHash },
          tx,
          {
            ipHash: 'a'.repeat(64),
            userAgentHash: 'b'.repeat(64),
          },
        ),
      );
      const rows = await tdb.db
        .select()
        .from(reviewDecisions)
        .where(eq(reviewDecisions.reviewRequestId, requestId));
      expect(rows[0]).toMatchObject({
        deciderKind: 'external_reviewer',
        deciderId: linkId,
        verifiedEmail: 'client@example.test',
        ipHash: 'a'.repeat(64),
      });
      const link = (
        await tdb.db.select().from(externalReviewerLinks).where(eq(externalReviewerLinks.id, linkId))
      )[0]!;
      expect(link.emailVerifiedAt).not.toBeNull();
      expect(link.lastUsedAt).not.toBeNull();
      expect((await approvalRow(res.approvalId!)).approverKind).toBe('external_reviewer');
      expect(await runA(() => evaluateRelease(pubFor({ approvalId: res.approvalId }), at))).toEqual({
        allow: true,
      });
      // Single use: the request is decided, so the same link cannot decide again (resource state).
      await expect(
        asExternal(external, (tx) =>
          reviewService.decisions.submit(
            external,
            {
              reviewRequestId: requestId,
              decision: 'reject',
              comment: 'no',
              expectedManifestHash: manifestHash,
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'resource_state' });
      // Team revocation takes effect on the next request: the same token is refused.
      await runA((tx) => reviewService.externalLinks.revoke(manager.actor, { linkId }, tx));
      // The request path refuses the token at tenant resolution; the policy refuses a revoked actor on its own too.
      await expect(reviewerActor(token)).rejects.toMatchObject({ reason: 'reviewer_link_revoked' });
      const again = { ...external, revoked: true };
      await expect(
        asExternal(again, () => reviewService.requests.get(again, { reviewRequestId: requestId })),
      ).rejects.toMatchObject({
        reason: 'reviewer_link_revoked',
      });
      // A revoked approver link blocks dispatch of the approval it granted.
      expect(await runA(() => evaluateRelease(pubFor({ approvalId: res.approvalId }), at))).toMatchObject({
        reasons: ['approver_still_authorised'],
      });
      expect(
        (await runA(() => reviewService.inbox.list(manager.actor, { page: { limit: 50 } }))).items.find(
          (i) => i.id === requestId,
        )?.attention,
      ).toContain('external_access_revoked');
    });

    it('expired links are refused; expiry does not void a recorded decision; team revocation does; links need an open request', async () => {
      await tdb.db
        .update(externalReviewerLinks)
        .set({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) })
        .where(eq(externalReviewerLinks.id, linkId));
      await expect(reviewerActor(token)).rejects.toMatchObject({ reason: 'reviewer_link_expired' });
      const expired = { ...external, revoked: false, expired: true };
      await expect(
        asExternal(expired, () => reviewService.requests.get(expired, { reviewRequestId: requestId })),
      ).rejects.toMatchObject({
        reason: 'reviewer_link_expired',
      });
      // An expired link does not void the decision it recorded; only the team's revocation does.
      const approvalId = (
        await tdb.db.select().from(releaseApprovals).where(eq(releaseApprovals.reviewRequestId, requestId))
      )[0]!.id;
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toEqual({ allow: true });
      await tdb.db
        .update(externalReviewerLinks)
        .set({ expiresAt: new Date(Date.now() + 3600_000) })
        .where(eq(externalReviewerLinks.id, linkId));
      await runA((tx) => reviewService.externalLinks.revoke(manager.actor, { linkId }, tx));
      expect(await runA(() => evaluateRelease(pubFor({ approvalId }), at))).toMatchObject({
        reasons: ['approver_still_authorised'],
      });
      expect(
        (await tdb.db.select().from(externalReviewerLinks).where(eq(externalReviewerLinks.id, linkId)))[0]!
          .revokedAt,
      ).not.toBeNull();
      await expect(
        runA((tx) =>
          reviewService.externalLinks.create(
            manager.actor,
            { reviewRequestId: requestId, email: 'x@example.test', expiresAt: '2030-01-01T00:00:00.000Z' },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ issue: 'request_not_open' }] });
    });
  });

  describe('mandates (spec 13.4, flag mandates.managed_autopublish)', () => {
    let mandateId = '';
    const spId = newId('servicePrincipal');
    const mandateInput = () => ({
      brandId: brandA,
      servicePrincipalId: spId,
      channelConnectionIds: [channelA],
      allowedContentClasses: ['general'],
      sourceRules: {
        onlyApprovedFacts: true,
        onlyApprovedTemplates: true,
        onlyApprovedAssets: true,
        requireBrandReviewClean: true,
      },
      maxPostsPerDay: 2,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2027-01-01T00:00:00.000Z',
    });

    it('creation is refused while the flag is off (default)', async () => {
      await expect(
        runA((tx) => reviewService.mandates.create(manager.actor, mandateInput(), tx)),
      ).rejects.toMatchObject({
        reason: 'feature_disabled',
      });
    });

    it('with the flag on for the tenant and the entitlement, an owner creates a mandate; the release evaluates the mandate path', async () => {
      await tdb.db.insert(servicePrincipals).values({
        id: spId,
        tenantId: tenantA,
        kind: 'agent',
        name: 'autopublisher',
        grants: [{ action: 'publication.schedule', brandIds: 'all' }],
        maxAutonomy: 'managed_autopublish',
        status: 'active',
        createdByUserId: manager.id,
      });
      await tdb.db.insert(featureFlags).values({
        key: 'mandates.managed_autopublish',
        enabledDefault: false,
        targeting: { tenantIds: [tenantA] },
        owner: 'review',
        removalDate: new Date('2027-06-30T00:00:00Z'),
        successMetric: 'test',
      });
      await tdb.db.insert(entitlements).values({
        id: newId('entitlement'),
        tenantId: tenantA,
        feature: 'managed_autopublish',
        enabled: 'yes',
        reason: 'test',
        grantedByUserId: manager.id,
      });
      // mandate.manage is an owner/admin action.
      await tdb.db.update(memberships).set({ role: 'owner' }).where(eq(memberships.id, manager.membershipId));
      const owner: ResolvedActor = {
        ...(manager.actor as Extract<ResolvedActor, { kind: 'user' }>),
        role: 'owner',
      };
      const created = await runA((tx) => reviewService.mandates.create(owner, mandateInput(), tx));
      mandateId = created.mandateId;
      expect(created.state).toBe('active');
      expect((await eventsOf(tenantA, 'mandate.changed')).length).toBe(1);
      const pub = pubFor({ authority: 'mandate', mandateId });
      expect(await runA(() => evaluateRelease(pub, at))).toEqual({ allow: true });
      checks.count = 2;
      expect(await runA(() => evaluateRelease(pub, at))).toMatchObject({ reasons: ['mandate_daily_quota'] });
      checks.count = 0;
      expect(
        await runA(() =>
          evaluateRelease(pubFor({ authority: 'mandate', mandateId, channelConnectionId: channelA2 }), at),
        ),
      ).toMatchObject({
        reasons: ['mandate_channel'],
      });
      expect(await runA(() => evaluateRelease(pub, new Date('2027-03-01T00:00:00Z')))).toMatchObject({
        reasons: ['mandate_active'],
      });
      await runA((tx) =>
        killSwitch.set('release_dispatch', brandA, true, 'incident', { kind: 'user', id: manager.id }, tx),
      );
      expect(await runA(() => evaluateRelease(pub, at))).toMatchObject({ reasons: ['kill_switch_off'] });
      await runA((tx) =>
        killSwitch.set('release_dispatch', brandA, false, null, { kind: 'user', id: manager.id }, tx),
      );
      const paused = await runA((tx) =>
        reviewService.mandates.pause(owner, { mandateId, expectedVersion: 0 }, tx),
      );
      expect(paused.state).toBe('paused');
      expect(await runA(() => evaluateRelease(pub, at))).toMatchObject({ reasons: ['mandate_active'] });
      const revoked = await runA((tx) =>
        reviewService.mandates.revoke(owner, { mandateId, expectedVersion: 1, reason: 'done' }, tx),
      );
      expect(revoked.state).toBe('revoked');
      await expect(
        runA((tx) => reviewService.mandates.pause(owner, { mandateId, expectedVersion: 2 }, tx)),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(
        await runA(() => evaluateRelease(pubFor({ authority: 'mandate', mandateId: null }), at)),
      ).toMatchObject({
        reasons: [
          'mandate_active',
          'mandate_channel',
          'mandate_content_class',
          'mandate_daily_quota',
          'mandate_sources',
          'owner_still_authorised',
        ],
      });
    });
  });

  describe('tenant isolation (spec 5.3)', () => {
    it('foreign ids are NOT_FOUND and nothing is written', async () => {
      const before = await tdb.db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantB));
      await expect(
        runA(() => reviewService.requests.get(manager.actor, { reviewRequestId: requestB })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runA((tx) =>
          reviewService.decisions.submit(
            manager.actor,
            { reviewRequestId: requestB, decision: 'approve', expectedManifestHash: 'x' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(runA(() => reviewService.approvals.getById(approvalB))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        runA((tx) =>
          reviewService.externalLinks.create(
            manager.actor,
            { reviewRequestId: requestB, email: 'x@example.test', expiresAt: '2030-01-01T00:00:00.000Z' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(runA(() => evaluateRelease(pubFor({ tenantId: tenantB }), at))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      expect(await tdb.db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantB))).toEqual(
        before,
      );
    });
  });

  describe('agent tool source (spec 12.4 review.request)', () => {
    const agent: ResolvedActorServicePrincipal = {
      kind: 'service_principal',
      id: 'sp_review_tools',
      tenantId: '',
      status: 'active',
      maxAutonomy: 'prepare_release',
      grants: [
        { action: 'brand.read', brandIds: 'all' },
        { action: 'review.request', brandIds: 'all' },
      ],
    };
    const runAsAgent = <T>(fn: (tx: Tx) => Promise<T>) =>
      runInTenant(
        { ...ctx(tenantA, 'sp_review_tools'), actor: { kind: 'service_principal', id: 'sp_review_tools' } },
        () => withTransaction(fn),
      );
    const input = (contentRevisionId: string, over: Record<string, unknown> = {}) => ({
      brandId: brandA,
      runId: 'run_review_tools',
      autonomyMode: 'prepare_release' as const,
      contentRevisionId,
      assigneeUserIds: [reviewer.id],
      timing,
      ...over,
    });

    it('opens a request as the agent under prepare_release; a lower mode or a foreign revision is refused', async () => {
      const A = { ...agent, tenantId: tenantA };
      const pkg = await runA((tx) =>
        contentService.packages.create(
          manager.actor,
          {
            brandId: brandA,
            title: 'Agent review',
            creativeDocumentIds: [],
            copy: { schemaVersion: 1, master: { text: 'Agent drafted caption', factRefs: [] } },
          },
          tx,
        ),
      );
      await runA((tx) =>
        contentService.variants.generate(
          manager.actor,
          { contentRevisionId: pkg.contentRevisionId, channelConnectionIds: [channelA] },
          tx,
        ),
      );
      await expect(
        runAsAgent((tx) =>
          reviewToolSource.requestReview(A, input(pkg.contentRevisionId, { autonomyMode: 'create' }), tx),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', reason: 'autonomy_insufficient' });
      const foreign = (
        await tdb.db.select().from(contentRevisions).where(eq(contentRevisions.tenantId, tenantB))
      )[0]!;
      const beforeB = await tdb.db.select().from(reviewRequests).where(eq(reviewRequests.tenantId, tenantB));
      await expect(
        runAsAgent((tx) => reviewToolSource.requestReview(A, input(foreign.id), tx)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runAsAgent((tx) =>
          reviewToolSource.requestReview(A, input(pkg.contentRevisionId, { brandId: brandB }), tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await tdb.db.select().from(reviewRequests).where(eq(reviewRequests.tenantId, tenantB))).toEqual(
        beforeB,
      );
      // an assignee must be an active member of this company: company B's manager (or an unknown id) is refused
      for (const assignee of [managerB.id, 'usr_unknown'])
        await expect(
          runAsAgent((tx) =>
            reviewToolSource.requestReview(
              A,
              input(pkg.contentRevisionId, { assigneeUserIds: [assignee] }),
              tx,
            ),
          ),
        ).rejects.toMatchObject({
          code: 'VALIDATION_FAILED',
          details: [{ path: 'assigneeUserIds.0', issue: 'assignee_not_found' }],
        });
      const opened = await runAsAgent((tx) =>
        reviewToolSource.requestReview(A, input(pkg.contentRevisionId), tx),
      );
      expect(await requestRow(opened.reviewRequestId)).toMatchObject({
        contentRevisionId: pkg.contentRevisionId,
        state: 'open',
        manifestHash: opened.manifestHash,
        assignees: [reviewer.id],
        requestedByKind: 'agent',
        requestedById: 'sp_review_tools',
      });
      expect((await runA(() => contentService.revisions.read(pkg.contentRevisionId))).state).toBe(
        'in_review',
      );
      // deciding stays with a person: the agent cannot approve its own request
      await expect(
        runAsAgent((tx) =>
          reviewService.decisions.submit(
            A,
            {
              reviewRequestId: opened.reviewRequestId,
              decision: 'approve',
              expectedManifestHash: opened.manifestHash,
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
    });
  });
});
