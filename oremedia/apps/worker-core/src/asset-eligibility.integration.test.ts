import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AgentRunWorkflowInputV1 } from '@oremedia/contracts/agents';
import type { AssetPurpose } from '@oremedia/contracts/assets';
import { defaultPolicyDocument, emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, Element } from '@oremedia/contracts/creative';
import { RightsIneligibleError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ResolvedSkill } from '@oremedia/contracts/skills';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, servicePrincipals, tenants, users } from '@oremedia/db/schema/access';
import { assetGrants, assetVersions, assets, usageRights } from '@oremedia/db/schema/assets';
import { brands } from '@oremedia/db/schema/brand';
import { renderedExports } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createRenderJobActivities, type FormatRenderer, type RenderJobStore } from '@oremedia/activities';
import {
  FakeModelAdapter,
  createReleaseOneRegistry,
  defaultContextResolverDeps,
  registerSkillResolver,
  resetRoutingPolicies,
  resetSkillResolver,
  resolveContextSnapshot,
  setTenantRoutingPolicy,
  type FakeModelStep,
} from '@oremedia/ai';
import {
  agentsService,
  configureAgentModel,
  createAgentRunRuntime,
  MemoryTranscriptStore,
} from '@oremedia/module-agents';
import { resolveTenantContext } from '@oremedia/module-access';
import { MemoryStorageProvider, assetService } from '@oremedia/module-assets';
import { brandService } from '@oremedia/module-brand';
import { CreativeRevisionRepository, RenderJobRepository, creativeService } from '@oremedia/module-creative';
import { runRenderJob } from '@oremedia/workflows/render-job.workflow.v1';
import { composeModules } from './composition';

/**
 * Phase 2 gate 2.g1 (spec 9.2, 12.3, 11.5): an ineligible asset never appears in search, agent context or render.
 * Search and authoriseUse are verified in the assets module; this file proves the two other callers go only through
 * them, against MySQL and the modules as worker-core composes them. Three assets become ineligible one at a time:
 *   - rights expired (usage_rights.expires_at moved into the past)            → rights_expired
 *   - grant revoked (the cross-brand asset_grant ends now; there is no revoke  → brand_not_permitted
 *     column, a grant is revoked by ending it)
 *   - quarantined / held for review (state back to pending_review: an upload  → state_not_approved
 *     held in quarantine never becomes an asset row, and a held asset is not approved)
 * For each, with a control asset that stays eligible:
 *   - search: assetService.findEligibleAssets omits it; authoriseUse refuses it with the reason;
 *   - agent context: resolveContextSnapshot (the real resolver deps) omits it, the system prompt the model is sent
 *     for the next step (FakeModelAdapter records it) does not contain its version id, and the assets.searchEligible
 *     tool dispatched through the agent runtime does not return it;
 *   - render: a render job of a document that references it (authorised when the document was made) fails with
 *     rights_ineligible naming the version and the reason, the renderer is never called and no export is written.
 * Before any asset is made ineligible, all of them appear everywhere (the checks are not vacuous).
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const elementId = () =>
  `el_${Array.from({ length: 26 }, () => CROCKFORD[Math.floor(Math.random() * 32)]).join('')}`;

const TOOLS = ['assets.searchEligible'];
const skill: ResolvedSkill = {
  skillVersionId: 'sv_01HELIGIBLESKILL00000000000',
  skillId: 'skl_01HELIGIBLESKILL0000000000',
  key: 'eligibility-probe',
  versionNumber: 1,
  manifest: {
    schemaVersion: 1,
    key: 'eligibility-probe',
    title: 'Probe',
    description: 'test',
    taskKinds: ['copywriting'],
    inputSchema: {},
    outputSchema: { type: 'object' },
    requiredContext: ['brand_snapshot'],
    allowedTools: TOOLS,
    budgets: {
      maxSteps: 10,
      maxTokens: 100_000,
      maxCostMicros: 2_000_000,
      maxVariants: 3,
      deadlineSeconds: 900,
    },
    modelCompatibility: [],
    instructionsPath: 'SKILL.md',
  },
  instructions: 'Find an image.',
  references: [],
};
const MODEL = {
  provider: 'fake',
  model: 'fake-model',
  maxOutputTokens: 1024,
  timeoutMs: 1000,
  inputMicrosPerMillionTokens: 1,
  outputMicrosPerMillionTokens: 1,
} as const;

type Subject = 'expired' | 'granted' | 'held';

describe('2.g1: ineligible assets never appear in search, agent context or render', () => {
  let tdb: TestDatabase;
  const tenantId = newId('ten');
  const brandA = newId('brd');
  const brandB = newId('brd');
  const spId = newId('sp');
  const owner = { id: newId('usr'), membershipId: newId('mem') };
  const ownerActor: ResolvedActor = {
    kind: 'user',
    id: owner.id,
    tenantId,
    membershipId: owner.membershipId,
    membershipStatus: 'active',
    role: 'owner',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  };
  const ctx = (actor: TenantContext['actor']): TenantContext => ({
    tenantId,
    actor,
    brandIds: 'all',
    correlationId: 'corr_eligibility',
  });
  const asOwner = <T>(fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx({ kind: 'user', id: owner.id }), () => withTransaction(fn));
  const readAsOwner = <T>(fn: () => Promise<T>) => runInTenant(ctx({ kind: 'user', id: owner.id }), fn);
  const asAgent = <T>(fn: () => Promise<T>) => runInTenant(ctx({ kind: 'service_principal', id: spId }), fn);

  /** Asset rows per key: the control stays eligible, the subjects are made ineligible one at a time. */
  const seeded: Record<'control' | Subject, { assetId: string; versionId: string }> = {} as never;

  async function seedPhoto(key: 'control' | Subject, brandId: string) {
    const assetId = newId('ast');
    const versionId = newId('av');
    await tdb.db.insert(assets).values({
      id: assetId,
      tenantId,
      brandId,
      kind: 'photo',
      name: `photo-${key}`,
      currentVersionId: versionId,
      state: 'approved',
      rightsState: 'recorded',
    });
    await tdb.db.insert(assetVersions).values({
      id: versionId,
      tenantId,
      brandId,
      assetId,
      number: 1,
      storageKey: `assets/${tenantId}/${brandId}/originals/${assetId}/${versionId}`,
      contentHash: 'c'.repeat(64),
      mime: 'image/png',
      bytes: 1024,
      width: 800,
      height: 600,
      provenance: { kind: 'upload', uploadedByUserId: owner.id, originalFilename: `${key}.png` },
    });
    await tdb.db.insert(usageRights).values({
      id: newId('ur'),
      tenantId,
      brandId,
      assetId,
      owner: 'owner',
      permittedChannels: 'all',
      territories: 'all',
      expiresAt: key === 'expired' ? new Date(Date.now() + 365 * 86_400_000) : null,
      releases: [],
      restrictions: [],
    });
    seeded[key] = { assetId, versionId };
  }

  /** Each subject's way of becoming ineligible, the reason the eligibility rule gives, and the way back. */
  const CASES: Array<{
    subject: Subject;
    label: string;
    reason: string;
    purpose: AssetPurpose;
    breakIt: () => Promise<unknown>;
    restore: () => Promise<unknown>;
  }> = [
    {
      subject: 'expired',
      label: 'rights expired',
      reason: 'rights_expired',
      purpose: 'creative',
      breakIt: () =>
        tdb.db
          .update(usageRights)
          .set({ expiresAt: new Date(Date.now() - 86_400_000) })
          .where(eq(usageRights.assetId, seeded.expired.assetId)),
      restore: () =>
        tdb.db
          .update(usageRights)
          .set({ expiresAt: new Date(Date.now() + 365 * 86_400_000) })
          .where(eq(usageRights.assetId, seeded.expired.assetId)),
    },
    {
      subject: 'granted',
      label: 'cross-brand grant revoked',
      reason: 'brand_not_permitted',
      purpose: 'creative',
      breakIt: () =>
        tdb.db
          .update(assetGrants)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(
            and(eq(assetGrants.assetId, seeded.granted.assetId), eq(assetGrants.granteeBrandId, brandA)),
          ),
      restore: () =>
        tdb.db
          .update(assetGrants)
          .set({ expiresAt: null })
          .where(
            and(eq(assetGrants.assetId, seeded.granted.assetId), eq(assetGrants.granteeBrandId, brandA)),
          ),
    },
    {
      subject: 'held',
      label: 'quarantined / held for review',
      reason: 'state_not_approved',
      purpose: 'creative',
      breakIt: () =>
        tdb.db.update(assets).set({ state: 'pending_review' }).where(eq(assets.id, seeded.held.assetId)),
      restore: () =>
        tdb.db.update(assets).set({ state: 'approved' }).where(eq(assets.id, seeded.held.assetId)),
    },
  ];
  const allKeys = ['control', 'expired', 'granted', 'held'] as const;

  // ---- the three callers ----

  const search = async () =>
    (
      await readAsOwner(() =>
        assetService.findEligibleAssets(
          { brandId: brandA, purpose: 'creative', channelConnectionIds: [] },
          { limit: 50 },
        ),
      )
    ).items.map((a) => a.assetVersionId);

  const registry = createReleaseOneRegistry();
  const contextIds = async (runId: string) => {
    const principal = await asAgent(async () => {
      const resolved = await resolveTenantContext(
        { kind: 'api_client', apiClientId: `run:${runId}`, servicePrincipalId: spId, tenantId, scopes: [] },
        tenantId,
        'corr_eligibility',
      );
      if (resolved.actor.kind !== 'service_principal') throw new Error('expected a service principal');
      return resolved.actor;
    });
    const snapshot = await asAgent(() =>
      resolveContextSnapshot(
        {
          tenantId,
          brandId: brandA,
          runId,
          correlationId: 'corr_eligibility',
          principal,
          requestedAutonomy: 'prepare_release',
          taskKind: 'copywriting',
          brief: {},
        },
        defaultContextResolverDeps(registry),
      ),
    );
    return snapshot.eligibleAssets.map((a) => a.assetVersionId);
  };

  let nextTurn: FakeModelStep = { kind: 'done', text: '{}' };
  const adapter = new FakeModelAdapter(() => nextTurn);
  const runtime = createAgentRunRuntime({
    adapter,
    modelConfig: MODEL,
    transcripts: new MemoryTranscriptStore(),
    registry,
  });
  let runInput: AgentRunWorkflowInputV1;
  let step = 0;
  /** One agent step: the model is shown the context (system prompt) and calls assets.searchEligible. */
  const agentStep = async () =>
    asAgent(async () => {
      nextTurn = {
        kind: 'tool_calls',
        toolCalls: [{ name: 'assets.searchEligible', arguments: { limit: 50 } }],
      };
      const planned = await runtime.planNextStep({ ...runInput, step });
      if (planned.kind !== 'tool_calls') throw new Error(`expected tool calls, got ${planned.kind}`);
      const result = await runtime.dispatchTool({
        ...runInput,
        step,
        stepId: planned.stepId,
        call: planned.toolCalls[0]!,
      });
      step += 1;
      const system = adapter.requests[adapter.requests.length - 1]!.system;
      if (result.kind !== 'ok') throw new Error(`tool ${result.kind}`);
      const items = (result.output as { items: Array<{ assetVersionId: string }> }).items;
      return { system, toolIds: items.map((i) => i.assetVersionId) };
    });

  // render: the creative module's render surface as the worker adapts it (apps/worker-render/src/creative-store.ts)
  const store: RenderJobStore = (() => {
    const jobs = new RenderJobRepository();
    const revisions = new CreativeRevisionRepository();
    return {
      async getJob(actor, renderJobId) {
        const job = await creativeService.renders.get(actor, { renderJobId });
        const row = await jobs.getById(renderJobId);
        const revision = await revisions.getById(job.revisionId);
        return {
          renderJobId: job.id,
          state: job.state,
          revisionId: job.revisionId,
          documentId: revision.documentId,
          brandId: row.brandId,
          formatKeys: job.formatKeys,
        };
      },
      async getRevision(actor, documentId, revisionId) {
        const r = await creativeService.revisions.get(actor, { documentId, revisionId });
        return { snapshot: r.snapshot, contentHash: r.contentHash, brandVersionId: r.brandVersionId };
      },
      markRendering: (id, tx) =>
        creativeService.renders.markRendering({ renderJobId: id }, tx).then(() => {}),
      markReady: async (id, exports, tx) => ({
        exportIds: (await creativeService.renders.markReady({ renderJobId: id, exports }, tx)).exportIds,
      }),
      markFailed: (id, error, tx) =>
        creativeService.renders.markFailed({ renderJobId: id, error }, tx).then(() => {}),
    };
  })();
  let renderCalls = 0;
  const renderer: FormatRenderer = {
    async render() {
      renderCalls += 1;
      throw new Error('the renderer must not be reached for an ineligible input');
    },
  };
  const acts = createRenderJobActivities({
    store,
    renderer,
    rendererVersion: 'eligibility-test',
    storage: new MemoryStorageProvider(),
  });
  let documentId = '';
  let revisionId = '';
  const jobInput = (renderJobId: string) => ({
    tenantId,
    actor: { kind: 'user' as const, id: owner.id },
    correlationId: 'corr_eligibility',
    renderJobId,
  });
  const requestRender = async () =>
    (
      await asOwner((tx) =>
        creativeService.renders.request(
          ownerActor,
          { documentId, revisionId, formatKeys: ['square_1080'] },
          tx,
        ),
      )
    ).renderJobId;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    composeModules();
    await tdb.db.insert(tenants).values({
      id: tenantId,
      name: 'Eligibility',
      slug: 'eligibility-' + tenantId.slice(-6).toLowerCase(),
      policy: { maxAutonomy: 'prepare_release' },
    });
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId, name: 'A', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId, name: 'B', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    await tdb.db.insert(users).values({
      id: owner.id,
      email: `eligibility-${owner.id.slice(-6).toLowerCase()}@example.test`,
      name: 'Owner',
    });
    await tdb.db.insert(memberships).values({
      id: owner.membershipId,
      tenantId,
      userId: owner.id,
      role: 'owner',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(servicePrincipals).values({
      id: spId,
      tenantId,
      kind: 'agent',
      name: 'designer',
      grants: [
        { action: 'brand.read', brandIds: 'all' },
        { action: 'asset.read', brandIds: 'all' },
      ],
      maxAutonomy: 'prepare_release',
      status: 'active',
      createdByUserId: owner.id,
    });
    const draft = await asOwner((tx) =>
      brandService.versions.createDraft(ownerActor, { brandId: brandA }, tx),
    );
    await asOwner((tx) =>
      brandService.versions.update(
        ownerActor,
        {
          brandId: brandA,
          versionId: draft.versionId,
          expectedVersion: 0,
          document: emptyBrandSystemDocument(),
        },
        tx,
      ),
    );
    await asOwner((tx) =>
      brandService.versions.submitForReview(
        ownerActor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 1 },
        tx,
      ),
    );
    await asOwner((tx) =>
      brandService.versions.publish(
        ownerActor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 2 },
        tx,
      ),
    );
    const pv = await asOwner((tx) =>
      brandService.policy.createVersion(
        ownerActor,
        { brandId: brandA, document: defaultPolicyDocument() },
        tx,
      ),
    );
    await asOwner((tx) =>
      brandService.policy.activate(
        ownerActor,
        { brandId: brandA, policyVersionId: pv.policyVersionId, expectedVersion: 0 },
        tx,
      ),
    );

    await seedPhoto('control', brandA);
    await seedPhoto('expired', brandA);
    await seedPhoto('held', brandA);
    await seedPhoto('granted', brandB); // brand B's photo, usable by brand A only through the grant
    await tdb.db.insert(assetGrants).values({
      id: newId('agr'),
      tenantId,
      brandId: brandB,
      assetId: seeded.granted.assetId,
      granteeBrandId: brandA,
      purpose: 'creative',
      expiresAt: null,
      createdByUserId: owner.id,
    });

    // A document in brand A that uses all four photos; every reference is authorised when it is created.
    const image = (key: keyof typeof seeded, x: number): Element => ({
      id: elementId(),
      name: `Photo ${key}`,
      type: 'image',
      locked: false,
      visible: true,
      opacity: 1,
      protected: false,
      transform: { x, y: 300, width: 240, height: 240, rotation: 0 },
      assetVersionId: seeded[key].versionId,
      fit: 'cover',
    });
    const created = await asOwner(async (tx) => {
      const snapshot = await brandService.resolveBrandSnapshot(ownerActor, { brandId: brandA }, tx);
      const document: CreativeDocumentV1 = {
        schemaVersion: 1,
        brandVersionId: snapshot.brandVersionId,
        variants: [],
        pages: [
          {
            id: 'page_1',
            name: 'Feed',
            formatKey: 'square_1080',
            width: 1080,
            height: 1080,
            layoutConstraints: [],
            elements: allKeys.map((k, i) => image(k, 20 + i * 260)),
          },
        ],
      };
      return creativeService.documents.create(
        ownerActor,
        { brandId: brandA, title: 'Eligibility', document },
        tx,
      );
    });
    documentId = created.documentId;
    revisionId = created.revisionId;

    registerSkillResolver(async () => [skill]);
    setTenantRoutingPolicy(tenantId, {
      schemaVersion: 1,
      defaultModel: 'fake-model',
      permittedVendors: ['fake'],
      permittedRegions: [],
      retention: 'standard_30d',
      dataClasses: ['brand_content'],
      deniedModels: [],
    });
    configureAgentModel(MODEL);
    const started = await asOwner((tx) =>
      agentsService.runs.start(
        ownerActor,
        {
          brandId: brandA,
          servicePrincipalId: spId,
          requestedAutonomy: 'prepare_release',
          taskKind: 'copywriting',
          brief: { objective: 'Pick a photo' },
        },
        tx,
      ),
    );
    runInput = {
      tenantId,
      actor: { kind: 'service_principal', id: spId },
      correlationId: 'corr_eligibility',
      runId: started.runId,
      brandId: brandA,
    };
    await asAgent(async () => {
      const resolved = await runtime.resolveContextSnapshot(runInput);
      expect(resolved.allowedTools).toEqual(TOOLS);
      await runtime.reserveBudget({ ...runInput, budget: resolved.budget });
    });
  }, 180_000);
  afterAll(async () => {
    resetSkillResolver();
    resetRoutingPolicies();
    configureAgentModel(null);
    await tdb?.drop();
  });

  it('control: while everything is eligible, all four photos appear in search, the agent context, the tool and the render inputs', async () => {
    const ids = allKeys.map((k) => seeded[k].versionId);
    expect(await search()).toEqual(expect.arrayContaining(ids));
    expect(await contextIds(runInput.runId)).toEqual(expect.arrayContaining(ids));
    const { system, toolIds } = await agentStep();
    for (const id of ids) expect(system).toContain(id);
    expect(toolIds).toEqual(expect.arrayContaining(ids));
    const renderJobId = await requestRender();
    const begun = await acts.beginRender(jobInput(renderJobId));
    const resolved = await acts.resolveRenderInputs({ ...jobInput(renderJobId), ...begun });
    expect(resolved.ok).toBe(true);
    if (resolved.ok)
      expect(resolved.manifest.assets.map((a) => a.assetVersionId).sort()).toEqual([...ids].sort());
  }, 120_000);

  it.each(CASES.map((c) => [c.label, c] as const))(
    '%s: absent from search and the agent context, refused by authoriseUse and by the render job',
    async (_label, c) => {
      const subject = seeded[c.subject].versionId;
      const control = seeded.control.versionId;
      await c.breakIt();
      try {
        // search (and authoriseUse, the point-of-effect check both callers rely on)
        const found = await search();
        expect(found).toContain(control);
        expect(found).not.toContain(subject);
        const denied = await readAsOwner(() =>
          assetService.authoriseUse(subject, c.purpose, { brandId: brandA }).then(
            () => null,
            (e: unknown) => e,
          ),
        );
        expect(denied).toBeInstanceOf(RightsIneligibleError);
        expect((denied as RightsIneligibleError).details).toEqual([{ path: subject, issue: c.reason }]);

        // agent context: the resolver, what the model is shown, and the search tool
        const context = await contextIds(runInput.runId);
        expect(context).toContain(control);
        expect(context).not.toContain(subject);
        const { system, toolIds } = await agentStep();
        expect(system).toContain(control);
        expect(system).not.toContain(subject);
        expect(toolIds).toContain(control);
        expect(toolIds).not.toContain(subject);

        // render: the job fails at input resolution, the renderer is never reached, nothing is exported
        const before = renderCalls;
        const renderJobId = await requestRender();
        const result = await runRenderJob(acts, jobInput(renderJobId));
        expect(result).toEqual({ outcome: 'failed', reason: 'rights_ineligible' });
        const view = await readAsOwner(() => creativeService.renders.get(ownerActor, { renderJobId }));
        expect(view.state).toBe('failed');
        expect(view.error).toBe(`rights_ineligible: ${subject}: ${c.reason}`);
        expect(renderCalls).toBe(before);
        expect(
          await tdb.db.select().from(renderedExports).where(eq(renderedExports.revisionId, revisionId)),
        ).toEqual([]);
      } finally {
        await c.restore();
      }
      // restored: eligible again everywhere (the next case starts from a clean state)
      expect(await search()).toContain(subject);
    },
    120_000,
  );
});
