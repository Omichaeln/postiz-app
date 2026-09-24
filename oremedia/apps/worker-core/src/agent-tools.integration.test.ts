import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AgentRunWorkflowInputV1, ToolResult } from '@oremedia/contracts/agents';
import {
  defaultPolicyDocument,
  emptyBrandSystemDocument,
  type BrandSystemDocumentV1,
} from '@oremedia/contracts/brand';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ResolvedSkill } from '@oremedia/contracts/skills';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, servicePrincipals, tenants, users } from '@oremedia/db/schema/access';
import { toolInvocations } from '@oremedia/db/schema/agents';
import { brands } from '@oremedia/db/schema/brand';
import { briefs, contentPackages, contentRevisions } from '@oremedia/db/schema/content';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { channelConnections, credentialRefs, publications } from '@oremedia/db/schema/publishing';
import { reviewRequests } from '@oremedia/db/schema/review';
import {
  FakeModelAdapter,
  registerSkillResolver,
  resetRoutingPolicies,
  resetSkillResolver,
  setTenantRoutingPolicy,
  type FakeModelStep,
} from '@oremedia/ai';
import {
  agentsService,
  configureAgentModel,
  createAgentRunRuntime,
  MemoryTranscriptStore,
} from '@oremedia/module-agents';
import { brandService } from '@oremedia/module-brand';
import { contentService } from '@oremedia/module-content';
import { reviewService } from '@oremedia/module-review';
import { composeModules } from './composition';

/**
 * Spec 12.4 Release 1 tools against the modules as worker-core composes them: a fake model calls
 * content.createBrief, content.draftCopy, review.request and publications.proposeSchedule through the real
 * dispatcher (runtime.dispatchTool) against MySQL. Each allowed call creates its object as the run's service
 * principal (audited, run id recorded); each call with a foreign tenant's id is denied not_found with nothing
 * written there; the proposed schedule is only a pending proposal: no publication, no publish event.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

const brandDocument = (): BrandSystemDocumentV1 => ({
  ...emptyBrandSystemDocument(),
  voice: { ...emptyBrandSystemDocument().voice, summary: 'Plain', tone: ['plain'], prohibitedPhrases: [] },
});
const TOOLS = ['content.createBrief', 'content.draftCopy', 'review.request', 'publications.proposeSchedule'];
const skill: ResolvedSkill = {
  skillVersionId: 'sv_01HTOOLSSKILL000000000000000',
  skillId: 'skl_01HTOOLSSKILL00000000000000',
  key: 'campaign-planning',
  versionNumber: 1,
  manifest: {
    schemaVersion: 1,
    key: 'campaign-planning',
    title: 'Plan',
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
  instructions: 'Plan and draft.',
  references: [],
};

describe('Release 1 content, review and publishing tools through the real dispatcher (worker-core composition)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const tenantB = newId('ten');
  const brandA = newId('brd');
  const brandB = newId('brd');
  const spA = newId('sp');
  const channelA = newId('cc');
  const channelB = newId('cc');
  const briefB = newId('brf');
  const revisionB = newId('crv');
  const manager = { id: newId('usr'), membershipId: newId('mem') };
  const managerActor: ResolvedActor = {
    kind: 'user',
    id: manager.id,
    tenantId: tenantA,
    membershipId: manager.membershipId,
    membershipStatus: 'active',
    role: 'brand_manager',
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  };
  const ctx = (tenantId: string, actor: TenantContext['actor']): TenantContext => ({
    tenantId,
    actor,
    brandIds: 'all',
    correlationId: 'corr_tools',
  });
  const asManager = <T>(fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx(tenantA, { kind: 'user', id: manager.id }), () => withTransaction(fn));
  const asAgent = <T>(fn: () => Promise<T>) =>
    runInTenant(ctx(tenantA, { kind: 'service_principal', id: spA }), fn);
  const snapshotOfB = async () =>
    JSON.stringify({
      briefs: await tdb.db.select().from(briefs).where(eq(briefs.tenantId, tenantB)),
      packages: await tdb.db.select().from(contentPackages).where(eq(contentPackages.tenantId, tenantB)),
      revisions: await tdb.db.select().from(contentRevisions).where(eq(contentRevisions.tenantId, tenantB)),
      requests: await tdb.db.select().from(reviewRequests).where(eq(reviewRequests.tenantId, tenantB)),
      publications: await tdb.db.select().from(publications).where(eq(publications.tenantId, tenantB)),
      audit: (await tdb.db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantB))).length,
    });

  async function channel(tenantId: string, brandId: string, id: string) {
    const credentialRefId = newId('cred');
    await tdb.db.insert(credentialRefs).values({
      id: credentialRefId,
      tenantId,
      kmsKeyId: 'fixture-kms-key',
      wrappedDataKey: 'fixture-wrapped-key',
      ciphertext: 'fixture-ciphertext',
      iv: 'fixture-iv',
      authTag: 'fixture-authtag',
      aad: `${tenantId}:${id}`,
    });
    await tdb.db.insert(channelConnections).values({
      id,
      tenantId,
      brandId,
      providerKey: 'fixture_provider',
      remoteAccountId: `acct-${id.slice(-8)}`,
      displayName: 'Fixture channel',
      credentialRefId,
      grantedScopes: [],
      missingScopes: [],
      status: 'active',
      tokenExpiresAt: null,
      capabilityVersion: 1,
    });
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    composeModules();
    await tdb.db.insert(tenants).values([
      {
        id: tenantA,
        name: 'Tools A',
        slug: 'tools-a-' + tenantA.slice(-6).toLowerCase(),
        policy: { maxAutonomy: 'prepare_release' },
      },
      { id: tenantB, name: 'Tools B', slug: 'tools-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    await tdb.db.insert(users).values({
      id: manager.id,
      email: `tools-${manager.id.slice(-6).toLowerCase()}@example.test`,
      name: 'Tools manager',
    });
    await tdb.db.insert(memberships).values({
      id: manager.membershipId,
      tenantId: tenantA,
      userId: manager.id,
      role: 'brand_manager',
      status: 'active',
      allBrands: true,
    });
    await tdb.db.insert(servicePrincipals).values({
      id: spA,
      tenantId: tenantA,
      kind: 'agent',
      name: 'planner',
      grants: [
        { action: 'brand.read', brandIds: 'all' },
        { action: 'content.plan', brandIds: 'all' },
        { action: 'content.edit', brandIds: 'all' },
        { action: 'review.request', brandIds: 'all' },
        { action: 'publication.schedule', brandIds: 'all', channelConnectionIds: 'all' },
      ],
      maxAutonomy: 'prepare_release',
      status: 'active',
      createdByUserId: manager.id,
    });
    const draft = await asManager((tx) =>
      brandService.versions.createDraft(managerActor, { brandId: brandA }, tx),
    );
    await asManager((tx) =>
      brandService.versions.update(
        managerActor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 0, document: brandDocument() },
        tx,
      ),
    );
    await asManager((tx) =>
      brandService.versions.submitForReview(
        managerActor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 1 },
        tx,
      ),
    );
    await asManager((tx) =>
      brandService.versions.publish(
        managerActor,
        { brandId: brandA, versionId: draft.versionId, expectedVersion: 2 },
        tx,
      ),
    );
    const pv = await asManager((tx) =>
      brandService.policy.createVersion(
        managerActor,
        { brandId: brandA, document: defaultPolicyDocument() },
        tx,
      ),
    );
    await asManager((tx) =>
      brandService.policy.activate(
        managerActor,
        { brandId: brandA, policyVersionId: pv.policyVersionId, expectedVersion: 0 },
        tx,
      ),
    );
    await channel(tenantA, brandA, channelA);
    // Tenant B's rows the model will try to use.
    await channel(tenantB, brandB, channelB);
    await tdb.db.insert(briefs).values({
      id: briefB,
      tenantId: tenantB,
      brandId: brandB,
      campaignId: null,
      audience: 'B audience',
      message: 'B message',
      offerFactIds: [],
      channelConnectionIds: [],
      constraints: [],
      state: 'draft',
      createdByKind: 'user',
      createdById: 'usr_b',
    });
    const packageB = newId('cpk');
    const copy = { schemaVersion: 1 as const, master: { text: 'B caption', factRefs: [] } };
    await tdb.db.insert(contentPackages).values({
      id: packageB,
      tenantId: tenantB,
      brandId: brandB,
      briefId: null,
      title: 'B package',
      currentRevisionId: revisionB,
      state: 'approved',
      version: 1,
    });
    await tdb.db.insert(contentRevisions).values({
      id: revisionB,
      tenantId: tenantB,
      brandId: brandB,
      packageId: packageB,
      number: 1,
      brandVersionId: newId('bv'),
      policyVersionId: newId('pv'),
      copy,
      creativeRevisionIds: [],
      factRefs: [],
      contentHash: 'b'.repeat(64),
      state: 'approved',
      authorKind: 'user',
      authorId: 'usr_b',
    });
    registerSkillResolver(async () => [skill]);
    setTenantRoutingPolicy(tenantA, {
      schemaVersion: 1,
      defaultModel: 'fake-model',
      permittedVendors: ['fake', 'anthropic'],
      permittedRegions: [],
      retention: 'standard_30d',
      dataClasses: ['brand_content'],
      deniedModels: [],
    });
    configureAgentModel({
      provider: 'fake',
      model: 'fake-model',
      maxOutputTokens: 1024,
      timeoutMs: 1000,
      inputMicrosPerMillionTokens: 1,
      outputMicrosPerMillionTokens: 1,
    });
  });
  afterAll(async () => {
    resetSkillResolver();
    resetRoutingPolicies();
    configureAgentModel(null);
    await tdb?.drop();
  });

  it('allowed calls create their objects as the service principal; foreign ids are denied; the schedule is only proposed', async () => {
    const started = await asManager((tx) =>
      agentsService.runs.start(
        managerActor,
        {
          brandId: brandA,
          servicePrincipalId: spA,
          requestedAutonomy: 'prepare_release',
          taskKind: 'copywriting',
          brief: { objective: 'Autumn restock' },
        },
        tx,
      ),
    );
    const runId = started.runId;
    expect(started.autonomyMode).toBe('prepare_release');
    // The model's next turn is set by the test between steps (it "reads" the previous tool results).
    let nextTurn: FakeModelStep = { kind: 'done', text: '{}' };
    const runtime = createAgentRunRuntime({
      adapter: new FakeModelAdapter(() => nextTurn),
      modelConfig: {
        provider: 'fake',
        model: 'fake-model',
        maxOutputTokens: 1024,
        timeoutMs: 1000,
        inputMicrosPerMillionTokens: 1,
        outputMicrosPerMillionTokens: 1,
      },
      transcripts: new MemoryTranscriptStore(),
    });
    const input: AgentRunWorkflowInputV1 = {
      tenantId: tenantA,
      actor: { kind: 'service_principal', id: spA },
      correlationId: 'corr_tools',
      runId,
      brandId: brandA,
    };
    let step = 0;
    const turn = (calls: Array<{ name: string; arguments: Record<string, unknown> }>) =>
      asAgent(async () => {
        nextTurn = { kind: 'tool_calls', toolCalls: calls };
        const planned = await runtime.planNextStep({ ...input, step });
        if (planned.kind !== 'tool_calls') throw new Error('expected tool calls');
        const results: ToolResult[] = [];
        for (const call of planned.toolCalls)
          results.push(await runtime.dispatchTool({ ...input, step, stepId: planned.stepId, call }));
        step += 1;
        return { stepId: planned.stepId, results };
      });
    const beforeB = await snapshotOfB();
    await asAgent(async () => {
      const resolved = await runtime.resolveContextSnapshot(input);
      expect(resolved.allowedTools).toEqual([...TOOLS].sort());
      await runtime.reserveBudget({ ...input, budget: resolved.budget });
    });

    // content.createBrief: a foreign channel is not_found; the brand's own channel creates a draft brief
    const briefTurn = await turn([
      {
        name: 'content.createBrief',
        arguments: { audience: 'Repeat buyers', message: 'Autumn restock', channelConnectionIds: [channelB] },
      },
      {
        name: 'content.createBrief',
        arguments: { audience: 'Repeat buyers', message: 'Autumn restock', channelConnectionIds: [channelA] },
      },
    ]);
    expect(briefTurn.results[0]).toEqual({ kind: 'denied', reason: 'not_found' });
    expect(briefTurn.results[1]).toMatchObject({ kind: 'ok', output: { state: 'draft' } });
    const briefId = (briefTurn.results[1] as { output: { briefId: string } }).output.briefId;
    expect((await tdb.db.select().from(briefs).where(eq(briefs.id, briefId)))[0]).toMatchObject({
      tenantId: tenantA,
      brandId: brandA,
      createdByKind: 'agent',
      createdById: spA,
      agentRunId: runId,
    });

    // content.draftCopy: tenant B's brief is not_found; the run's brief gets a draft revision
    const draftTurn = await turn([
      {
        name: 'content.draftCopy',
        arguments: { briefId: briefB, variants: [{ text: 'x', rationale: 'r' }] },
      },
      {
        name: 'content.draftCopy',
        arguments: { briefId, variants: [{ text: 'Autumn is back in stock', rationale: 'plain and short' }] },
      },
    ]);
    expect(draftTurn.results[0]).toEqual({ kind: 'denied', reason: 'not_found' });
    expect(draftTurn.results[1]).toMatchObject({ kind: 'ok', output: { state: 'draft' } });
    const draft = (draftTurn.results[1] as { output: { drafts: Array<{ contentRevisionId: string }> } })
      .output.drafts[0]!;
    expect(
      (
        await tdb.db.select().from(contentRevisions).where(eq(contentRevisions.id, draft.contentRevisionId))
      )[0],
    ).toMatchObject({ state: 'draft', authorKind: 'agent', authorId: spA, agentRunId: runId });

    // a person prepares the channel variant (spec 14.1); the agent then requests review
    await asManager((tx) =>
      contentService.variants.generate(
        managerActor,
        { contentRevisionId: draft.contentRevisionId, channelConnectionIds: [channelA] },
        tx,
      ),
    );
    const slot = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const reviewTurn = await turn([
      {
        name: 'review.request',
        arguments: { contentRevisionId: revisionB, timing: { kind: 'exact', at: slot } },
      },
      {
        name: 'review.request',
        arguments: {
          contentRevisionId: draft.contentRevisionId,
          reviewerUserIds: [manager.id],
          timing: { kind: 'exact', at: slot },
        },
      },
    ]);
    expect(reviewTurn.results[0]).toEqual({ kind: 'denied', reason: 'not_found' });
    expect(reviewTurn.results[1]).toMatchObject({ kind: 'ok', output: { state: 'open' } });
    const request = (reviewTurn.results[1] as { output: { reviewRequestId: string; manifestHash: string } })
      .output;
    expect(
      (await tdb.db.select().from(reviewRequests).where(eq(reviewRequests.id, request.reviewRequestId)))[0],
    ).toMatchObject({ requestedByKind: 'agent', requestedById: spA, state: 'open' });

    // the person approves; the agent proposes the slot (a foreign channel is not_found)
    await asManager((tx) =>
      reviewService.decisions.submit(
        managerActor,
        {
          reviewRequestId: request.reviewRequestId,
          decision: 'approve',
          expectedManifestHash: request.manifestHash,
        },
        tx,
      ),
    );
    const scheduleTurn = await turn([
      {
        name: 'publications.proposeSchedule',
        arguments: {
          contentRevisionId: draft.contentRevisionId,
          channelConnectionIds: [channelB],
          proposedAt: slot,
        },
      },
      {
        name: 'publications.proposeSchedule',
        arguments: {
          contentRevisionId: draft.contentRevisionId,
          channelConnectionIds: [channelA],
          proposedAt: slot,
        },
      },
    ]);
    expect(scheduleTurn.results[0]).toEqual({ kind: 'denied', reason: 'not_found' });
    expect(scheduleTurn.results[1]).toMatchObject({
      kind: 'proposal_requires_user',
      stepId: scheduleTurn.stepId,
    });
    const proposal = (
      await tdb.db
        .select()
        .from(toolInvocations)
        .where(and(eq(toolInvocations.runId, runId), eq(toolInvocations.outcome, 'proposal')))
    )[0]!;
    expect(proposal.proposalPayload).toMatchObject({
      completion: 'person',
      command: 'publications.schedule',
      contentRevisionId: draft.contentRevisionId,
      entries: [{ channelConnectionId: channelA, scheduledFor: slot }],
    });
    expect((await asManager(() => agentsService.runs.get(managerActor, { runId }))).state).toBe(
      'waiting_for_review',
    );
    // Deciding on a proposed schedule needs publication.schedule (the proposing tool's action), not creative.edit:
    // a creator is refused, a publisher may accept.
    const decide = (role: ResolvedActor & { kind: 'user' }, decision: 'accept' | 'reject') =>
      asManager((tx) =>
        agentsService.runs.approveProposal(role, { runId, stepId: scheduleTurn.stepId, decision }, tx),
      );
    const creatorActor = { ...managerActor, role: 'creator' } as ResolvedActor & { kind: 'user' };
    const publisherActor = { ...managerActor, role: 'publisher' } as ResolvedActor & { kind: 'user' };
    await expect(decide(creatorActor, 'reject')).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(decide(publisherActor, 'accept')).resolves.toMatchObject({ decision: 'accept' });

    // every allowed call was audited as the service principal, module command and dispatcher alike
    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.actorId, spA)));
    const actions = new Set(audits.map((a) => a.action));
    for (const action of [
      'agent.tool.content.createBrief',
      'agent.tool.content.draftCopy',
      'agent.tool.review.request',
      'agent.tool.publications.proposeSchedule',
      'content.brief.create',
      'content.package.create',
      'review.request.create',
    ])
      expect(actions, action).toContain(action);
    // no external effect: nothing scheduled or published anywhere, and nothing landed in tenant B
    expect(await tdb.db.select().from(publications)).toEqual([]);
    expect(
      await tdb.db.select().from(outboxEvents).where(like(outboxEvents.eventType, 'publication.%')),
    ).toEqual([]);
    expect(await snapshotOfB()).toBe(beforeB);
  });
});
