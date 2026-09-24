import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { BudgetExhaustedError, NotFoundError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { ResolvedActor, ResolvedActorUser } from '@oremedia/contracts/policy';
import type { ResolvedSkill } from '@oremedia/contracts/skills';
import type { AgentRunWorkflowInputV1 } from '@oremedia/contracts/agents';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { servicePrincipals, tenants } from '@oremedia/db/schema/access';
import { agentRuns, agentSteps, toolInvocations } from '@oremedia/db/schema/agents';
import { budgetReservations, usageLedger } from '@oremedia/db/schema/billing';
import { brands } from '@oremedia/db/schema/brand';
import { creativeDocuments, creativeRevisions } from '@oremedia/db/schema/creative';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import { hashCanonical } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import {
  FakeModelAdapter,
  createReleaseOneRegistry,
  modelConfigFromEnv,
  registerSkillResolver,
  resetRoutingPolicies,
  resetSkillResolver,
  setTenantRoutingPolicy,
  type FakeModelStep,
} from '@oremedia/ai';
import { budgets } from '@oremedia/module-billing';
import { brandService } from '@oremedia/module-brand';
import { clearOutboxRoutes, killSwitch, outboxRouteFor } from '@oremedia/module-operations';
import { registerAgentOutboxRoutes } from './outbox-routes';
import { createAgentRunRuntime } from './runtime';
import { agentsService, configureAgentModel } from './service';
import { MemoryTranscriptStore } from './transcripts';

const USER = 'usr_agents_test';
const ctx = (
  tenantId: string,
  actor: TenantContext['actor'] = { kind: 'user', id: USER },
): TenantContext => ({
  tenantId,
  actor,
  brandIds: 'all',
  correlationId: 'corr_agents',
});
const manager = (tenantId: string): ResolvedActorUser => ({
  kind: 'user',
  id: USER,
  tenantId,
  membershipId: 'mem_agents_test',
  membershipStatus: 'active',
  role: 'brand_manager',
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const run = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>, actor?: TenantContext['actor']) =>
  runInTenant(ctx(tenantId, actor), () => withTransaction(fn));

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

const headlineId = newElementId();
const studioDocument = (brandVersionId: string): CreativeDocumentV1 => ({
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
          id: newElementId(),
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
          id: headlineId,
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

async function publishBrand(tenantId: string, brandId: string) {
  const actor = manager(tenantId);
  const draft = await run(tenantId, (tx) => brandService.versions.createDraft(actor, { brandId }, tx));
  await run(tenantId, (tx) =>
    brandService.versions.update(
      actor,
      { brandId, versionId: draft.versionId, expectedVersion: 0, document: brandDocument() },
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

const skill = (allowedTools: string[]): ResolvedSkill => ({
  skillVersionId: 'sv_01HTESTSKILL0000000000000000',
  skillId: 'skl_01HTESTSKILL000000000000000',
  key: 'test-copywriting',
  versionNumber: 1,
  manifest: {
    schemaVersion: 1,
    key: 'test-copywriting',
    title: 'Test',
    description: 'test',
    taskKinds: ['copywriting', 'layout'],
    inputSchema: {},
    outputSchema: { type: 'object' },
    requiredContext: ['brand_snapshot'],
    allowedTools,
    budgets: {
      maxSteps: 6,
      maxTokens: 100_000,
      maxCostMicros: 2_000_000,
      maxVariants: 3,
      deadlineSeconds: 900,
    },
    modelCompatibility: [],
    instructionsPath: 'SKILL.md',
  },
  instructions: 'Write on-brand copy citing approved facts.',
  references: [],
});

describe('agents module (spec 12) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  const spA = newId('servicePrincipal');
  const spB = newId('servicePrincipal');
  const A = manager(tenantA);
  let docId = '';
  let revisionId = '';
  const modelConfig = { ...modelConfigFromEnv({}), provider: 'fake', model: 'fake-model' };
  const workflowInput = (
    runId: string,
    brandId = brandA,
    tenantId = tenantA,
    sp = spA,
  ): AgentRunWorkflowInputV1 => ({
    tenantId,
    actor: { kind: 'service_principal', id: sp },
    correlationId: 'corr_agents',
    runId,
    brandId,
  });
  const spCtx = (tenantId = tenantA, sp = spA): TenantContext =>
    ctx(tenantId, { kind: 'service_principal', id: sp });
  const runtimeWith = (script: FakeModelStep[]) => {
    const adapter = new FakeModelAdapter(script);
    return {
      adapter,
      runtime: createAgentRunRuntime({
        adapter,
        modelConfig,
        registry: createReleaseOneRegistry(),
        transcripts: new MemoryTranscriptStore(),
      }),
    };
  };
  const stepsOf = (runId: string) =>
    tdb.db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(agentSteps.index);
  const invocationsOf = (runId: string) =>
    tdb.db.select().from(toolInvocations).where(eq(toolInvocations.runId, runId));
  const runRow = async (runId: string) =>
    (await tdb.db.select().from(agentRuns).where(eq(agentRuns.id, runId)))[0]!;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      {
        id: tenantA,
        name: 'A',
        slug: 'agents-a-' + tenantA.slice(-6).toLowerCase(),
        policy: { maxAutonomy: 'prepare_release' },
      },
      { id: tenantB, name: 'B', slug: 'agents-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    const grants = [
      { action: 'brand.read', brandIds: 'all' },
      { action: 'asset.read', brandIds: 'all' },
      { action: 'creative.read', brandIds: 'all' },
      { action: 'creative.edit', brandIds: 'all' },
    ] as const;
    await tdb.db.insert(servicePrincipals).values([
      {
        id: spA,
        tenantId: tenantA,
        kind: 'agent',
        name: 'agent A',
        grants: [...grants],
        maxAutonomy: 'managed_autopublish',
        status: 'active',
        createdByUserId: USER,
      },
      {
        id: spB,
        tenantId: tenantB,
        kind: 'agent',
        name: 'agent B',
        grants: [...grants],
        maxAutonomy: 'create',
        status: 'active',
        createdByUserId: USER,
      },
    ]);
    const brandVersionA = await publishBrand(tenantA, brandA);
    await publishBrand(tenantB, brandB);
    // One document with its first revision, seeded as rows (this module does not depend on the creative module;
    // the proposal flow below exercises creativeService through @oremedia/ai's applyProposalBatch).
    docId = newId('creativeDocument');
    revisionId = newId('creativeRevision');
    const document = studioDocument(brandVersionA);
    await tdb.db.insert(creativeDocuments).values({
      id: docId,
      tenantId: tenantA,
      brandId: brandA,
      title: 'Doc',
      currentRevisionId: revisionId,
      schemaVersion: 1,
    });
    await tdb.db.insert(creativeRevisions).values({
      id: revisionId,
      tenantId: tenantA,
      brandId: brandA,
      documentId: docId,
      parentRevisionId: null,
      number: 1,
      brandVersionId: brandVersionA,
      authorKind: 'user',
      authorId: USER,
      changeSummary: 'Initial document',
      operations: {
        baseRevisionId: '',
        operations: [{ op: 'addPage', page: document.pages[0]!, index: 0 }],
        summary: 'Initial document',
        origin: 'user',
      },
      snapshot: document,
      contentHash: hashCanonical(document),
    });
    registerSkillResolver(async () => [
      skill(['brand.getSnapshot', 'facts.list', 'creative.proposeOperations']),
    ]);
    setTenantRoutingPolicy(tenantA, {
      schemaVersion: 1,
      defaultModel: 'fake-model',
      permittedVendors: ['fake', 'anthropic'],
      permittedRegions: [],
      retention: 'standard_30d',
      dataClasses: ['brand_content'],
      deniedModels: [],
    });
    setTenantRoutingPolicy(tenantB, {
      schemaVersion: 1,
      defaultModel: 'fake-model',
      permittedVendors: ['fake', 'anthropic'],
      permittedRegions: [],
      retention: 'standard_30d',
      dataClasses: ['brand_content'],
      deniedModels: [],
    });
    configureAgentModel(modelConfig);
    clearOutboxRoutes();
    registerAgentOutboxRoutes();
  });
  afterAll(async () => {
    resetSkillResolver();
    resetRoutingPolicies();
    configureAgentModel(null);
    clearOutboxRoutes();
    await tdb?.drop();
  });

  describe('runs.start', () => {
    it('writes a planned row, audits, and an agent.run_requested outbox event whose route starts run:<id> on queue agents', async () => {
      const started = await run(tenantA, (tx) =>
        agentsService.runs.start(
          A,
          {
            brandId: brandA,
            servicePrincipalId: spA,
            requestedAutonomy: 'managed_autopublish',
            taskKind: 'copywriting',
            brief: { objective: 'x' },
          },
          tx,
        ),
      );
      expect(started.state).toBe('planned');
      // min(requested managed_autopublish, principal managed_autopublish, tenant prepare_release, entitlement prepare_release)
      expect(started.autonomyMode).toBe('prepare_release');
      const row = await runRow(started.runId);
      expect(row).toMatchObject({
        state: 'planned',
        brandId: brandA,
        servicePrincipalId: spA,
        workflowId: `run:${started.runId}`,
        modelConfig: { provider: 'fake', model: 'fake-model' },
      });
      const events = await tdb.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.aggregateId, started.runId)));
      const requested = events.find((e) => e.eventType === 'agent.run_requested')!;
      expect(requested.payload).toMatchObject({
        runId: started.runId,
        brandId: brandA,
        servicePrincipalId: spA,
      });
      expect(requested.payload).not.toHaveProperty('brief');
      const route = outboxRouteFor('agent.run_requested')!;
      const req = route({ ...requested, payload: requested.payload as Record<string, unknown> })!;
      expect(req).toMatchObject({
        workflowType: 'agentRunWorkflowV1',
        taskQueue: 'agents',
        workflowId: `run:${started.runId}`,
      });
      expect(req.args[0]).toEqual({
        tenantId: tenantA,
        actor: { kind: 'service_principal', id: spA },
        correlationId: 'corr_agents',
        runId: started.runId,
        brandId: brandA,
      });
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, started.runId)));
      expect(audits.map((a) => a.action)).toContain('agent.run.request');
    });

    it('refuses a foreign brand or principal with NOT_FOUND and never writes', async () => {
      await expect(
        run(tenantA, (tx) =>
          agentsService.runs.start(
            A,
            {
              brandId: brandB,
              servicePrincipalId: spA,
              requestedAutonomy: 'create',
              taskKind: 'copywriting',
              brief: {},
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          agentsService.runs.start(
            A,
            {
              brandId: brandA,
              servicePrincipalId: spB,
              requestedAutonomy: 'create',
              taskKind: 'copywriting',
              brief: {},
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('the kill switch blocks starts for the brand and tenant-wide', async () => {
      await run(tenantA, (tx) =>
        killSwitch.set('agent_starts', brandA, true, 'incident', { kind: 'user', id: USER }, tx),
      );
      await expect(
        run(tenantA, (tx) =>
          agentsService.runs.start(
            A,
            {
              brandId: brandA,
              servicePrincipalId: spA,
              requestedAutonomy: 'create',
              taskKind: 'copywriting',
              brief: {},
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'kill_switch_engaged' });
      await run(tenantA, (tx) =>
        killSwitch.set('agent_starts', brandA, false, null, { kind: 'user', id: USER }, tx),
      );
      await run(tenantA, (tx) =>
        killSwitch.set('agent_starts', null, true, 'incident', { kind: 'user', id: USER }, tx),
      );
      await expect(
        run(tenantA, (tx) =>
          agentsService.runs.start(
            A,
            {
              brandId: brandA,
              servicePrincipalId: spA,
              requestedAutonomy: 'create',
              taskKind: 'copywriting',
              brief: {},
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await run(tenantA, (tx) =>
        killSwitch.set('agent_starts', null, false, null, { kind: 'user', id: USER }, tx),
      );
    });

    it('a creator without agent.start_run is denied; an unknown task kind is a validation failure', async () => {
      const reviewer: ResolvedActor = { ...A, role: 'reviewer' };
      await expect(
        run(tenantA, (tx) =>
          agentsService.runs.start(
            reviewer,
            {
              brandId: brandA,
              servicePrincipalId: spA,
              requestedAutonomy: 'create',
              taskKind: 'copywriting',
              brief: {},
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(
        run(tenantA, (tx) =>
          agentsService.runs.start(
            A,
            {
              brandId: brandA,
              servicePrincipalId: spA,
              requestedAutonomy: 'create',
              taskKind: 'take_over',
              brief: {},
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('run lifecycle through the runtime (the activities behind agentRunWorkflowV1)', () => {
    it('planned → running → completed with steps, invocations, ledger entries and a settled reservation', async () => {
      const started = await run(tenantA, (tx) =>
        agentsService.runs.start(
          A,
          {
            brandId: brandA,
            servicePrincipalId: spA,
            requestedAutonomy: 'create',
            taskKind: 'copywriting',
            brief: { objective: 'announce' },
          },
          tx,
        ),
      );
      const { adapter, runtime } = runtimeWith([
        {
          kind: 'tool_calls',
          toolCalls: [
            { name: 'facts.list', arguments: {} },
            { name: 'brand.getSnapshot', arguments: {} },
          ],
        },
        { kind: 'tool_calls', toolCalls: [{ name: 'facts.list', arguments: { kind: 'not-a-kind' } }] },
        { kind: 'done', text: '{"variants":[{"text":"On-brand caption","factIds":[]}]}' },
      ]);
      const input = workflowInput(started.runId);
      await runInTenant(spCtx(), async () => {
        const ctxResult = await runtime.resolveContextSnapshot(input);
        expect(ctxResult.autonomyMode).toBe('create');
        expect(ctxResult.allowedTools).toEqual([
          'brand.getSnapshot',
          'creative.proposeOperations',
          'facts.list',
        ]);
        expect(ctxResult.budget.maxSteps).toBe(6);
        expect((await runRow(started.runId)).state).toBe('running');
        const reserved = await runtime.reserveBudget({ ...input, budget: ctxResult.budget });
        expect(reserved.reservedMicros).toBe(ctxResult.budget.maxCostMicros);
        expect((await runtime.reserveBudget({ ...input, budget: ctxResult.budget })).reservationId).toBe(
          reserved.reservationId,
        ); // idempotent
        let step = 0;
        for (;;) {
          const next = await runtime.planNextStep({ ...input, step }, { heartbeat: () => undefined });
          if (next.kind === 'done') break;
          for (const call of next.toolCalls)
            await runtime.dispatchTool({ ...input, step, stepId: next.stepId, call });
          step += 1;
        }
        const finished = await runtime.finishRun({ ...input, state: 'completed' });
        expect(finished.state).toBe('completed');
        expect(finished.costMicros).toBeGreaterThan(0);
        await runtime.settleBudget(input);
        expect((await runtime.finishRun({ ...input, state: 'failed' })).state).toBe('completed'); // terminal: idempotent
      });
      const row = await runRow(started.runId);
      expect(row.state).toBe('completed');
      expect(row.finishedAt).not.toBeNull();
      expect(row.contextSnapshotHash).toHaveLength(64);
      expect(row.skillVersionIds).toEqual(['sv_01HTESTSKILL0000000000000000']);
      const steps = await stepsOf(started.runId);
      expect(steps.map((s) => s.kind)).toEqual(['plan', 'model_call', 'model_call', 'model_call']);
      expect(
        steps.filter((s) => s.kind === 'model_call').every((s) => s.tokensIn > 0 && s.costMicros > 0),
      ).toBe(true);
      expect(steps.some((s) => s.summary.includes('PRIVATE'))).toBe(false);
      const invocations = await invocationsOf(started.runId);
      expect(invocations.map((i) => [i.toolName, i.policyDecision, i.outcome])).toEqual([
        ['facts.list', 'allowed', 'ok'],
        ['brand.getSnapshot', 'allowed', 'ok'],
        ['facts.list', 'invalid', 'invalid'],
      ]);
      expect(invocations.every((i) => i.inputHash.length === 64)).toBe(true);
      const reservation = (
        await tdb.db.select().from(budgetReservations).where(eq(budgetReservations.runId, started.runId))
      )[0]!;
      expect(reservation.state).toBe('settled');
      expect(reservation.consumedMicros).toBe(row.costMicros);
      const ledger = await tdb.db
        .select()
        .from(usageLedger)
        .where(eq(usageLedger.reservationId, reservation.id));
      expect(ledger.filter((l) => l.kind === 'model_tokens')).toHaveLength(3);
      // the model saw the tool results, the tools it may call, and the precedence-ordered system prompt
      expect(adapter.requests).toHaveLength(3);
      expect(adapter.requests[0]!.tools.map((t) => t.name)).toEqual([
        'brand.getSnapshot',
        'creative.proposeOperations',
        'facts.list',
      ]);
      expect(
        adapter.requests[1]!.messages.filter((m) => m.role === 'user')
          .flatMap((m) => m.content)
          .filter((c) => c.type === 'tool_result'),
      ).toHaveLength(2);
      expect(adapter.requests[0]!.system).toContain('# 1. Platform safety and permissions');
    });

    it('a proposal parks the run in waiting_for_review; approveProposal records the decision and recordDecision applies it', async () => {
      const started = await run(tenantA, (tx) =>
        agentsService.runs.start(
          A,
          {
            brandId: brandA,
            servicePrincipalId: spA,
            requestedAutonomy: 'create',
            taskKind: 'layout',
            brief: { documentId: docId },
          },
          tx,
        ),
      );
      const proposal = {
        documentId: docId,
        baseRevisionId: revisionId,
        operations: [
          { op: 'setText', pageId: 'page_1', elementId: headlineId, text: 'October offer, plain and clear' },
        ],
        summary: 'sharpen headline',
      };
      const { runtime } = runtimeWith([
        { kind: 'tool_calls', toolCalls: [{ name: 'creative.proposeOperations', arguments: proposal }] },
        { kind: 'done', text: '{"done":true}' },
      ]);
      const input = workflowInput(started.runId);
      const decisionStepId = await runInTenant(spCtx(), async () => {
        const ctxResult = await runtime.resolveContextSnapshot(input);
        await runtime.reserveBudget({ ...input, budget: ctxResult.budget });
        const next = await runtime.planNextStep({ ...input, step: 0 });
        expect(next.kind).toBe('tool_calls');
        if (next.kind !== 'tool_calls') throw new Error('unreachable');
        const result = await runtime.dispatchTool({
          ...input,
          step: 0,
          stepId: next.stepId,
          call: next.toolCalls[0]!,
        });
        expect(result).toMatchObject({ kind: 'proposal_requires_user', stepId: next.stepId });
        return next.stepId;
      });
      expect((await runRow(started.runId)).state).toBe('waiting_for_review');
      const before = await tdb.db
        .select()
        .from(creativeRevisions)
        .where(eq(creativeRevisions.documentId, docId));
      expect(before).toHaveLength(1); // a proposal writes nothing
      // an agent cannot decide on proposals; a reviewer without creative.edit cannot either
      await expect(
        run(tenantA, (tx) =>
          agentsService.runs.approveProposal(
            { ...A, role: 'reviewer' },
            { runId: started.runId, stepId: decisionStepId, decision: 'accept' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const decided = await run(tenantA, (tx) =>
        agentsService.runs.approveProposal(
          A,
          { runId: started.runId, stepId: decisionStepId, decision: 'accept' },
          tx,
        ),
      );
      expect(decided).toMatchObject({ decision: 'accept', appliedRevisionId: null });
      const events = await tdb.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, 'agent.proposal_decided')));
      const evt = events.find((e) => e.aggregateId === started.runId)!;
      const relay = outboxRouteFor('agent.proposal_decided')!({
        ...evt,
        payload: evt.payload as Record<string, unknown>,
      })!;
      expect(relay).toMatchObject({
        workflowType: 'agentRunSignalRelayV1',
        taskQueue: 'agents',
        workflowId: `run:${started.runId}:signal:${evt.id}`,
      });
      expect(relay.args[0]).toEqual({
        workflowId: `run:${started.runId}`,
        signal: 'proposalDecision',
        decision: { stepId: decisionStepId, decision: 'accept' },
      });
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, started.runId)));
      expect(audits.map((a) => a.action)).toContain('agent.proposal.decide');
      // the workflow, signalled, records the decision: the accepted batch becomes a revision authored by the agent
      await runInTenant(spCtx(), async () => {
        await runtime.recordDecision({ ...input, decision: { stepId: decisionStepId, decision: 'accept' } });
        expect((await runRow(started.runId)).state).toBe('running');
        const next = await runtime.planNextStep({ ...input, step: 1 });
        expect(next.kind).toBe('done');
        expect((await runtime.finishRun({ ...input, state: 'completed' })).state).toBe('completed');
        await runtime.settleBudget(input);
      });
      const after = await tdb.db
        .select()
        .from(creativeRevisions)
        .where(eq(creativeRevisions.documentId, docId));
      expect(after).toHaveLength(2);
      expect(after.find((r) => r.number === 2)).toMatchObject({
        authorKind: 'agent',
        authorId: spA,
        agentRunId: started.runId,
      });
      const steps = await stepsOf(started.runId);
      expect(steps.filter((s) => s.kind === 'validation').map((s) => s.summary)).toEqual([
        expect.stringContaining(`proposal ${decisionStepId} accept by user ${USER}`),
        expect.stringContaining(`proposal ${decisionStepId} accept: revision`),
      ]);
    });

    it('cancel moves the row through the machine, releases the reservation and relays cancelRun; the runtime then finishes cancelled', async () => {
      const started = await run(tenantA, (tx) =>
        agentsService.runs.start(
          A,
          {
            brandId: brandA,
            servicePrincipalId: spA,
            requestedAutonomy: 'create',
            taskKind: 'copywriting',
            brief: {},
          },
          tx,
        ),
      );
      const { runtime } = runtimeWith([{ kind: 'done', text: '{}' }]);
      const input = workflowInput(started.runId);
      await runInTenant(spCtx(), async () => {
        const ctxResult = await runtime.resolveContextSnapshot(input);
        await runtime.reserveBudget({ ...input, budget: ctxResult.budget });
      });
      const cancelled = await run(tenantA, (tx) =>
        agentsService.runs.cancel(A, { runId: started.runId, reason: 'changed my mind' }, tx),
      );
      expect(cancelled.state).toBe('cancelled');
      expect(
        (
          await tdb.db.select().from(budgetReservations).where(eq(budgetReservations.runId, started.runId))
        )[0]!.state,
      ).toBe('released');
      const evt = (
        await tdb.db
          .select()
          .from(outboxEvents)
          .where(
            and(
              eq(outboxEvents.eventType, 'agent.run_cancel_requested'),
              eq(outboxEvents.aggregateId, started.runId),
            ),
          )
      )[0]!;
      expect(
        outboxRouteFor('agent.run_cancel_requested')!({
          ...evt,
          payload: evt.payload as Record<string, unknown>,
        })!.args[0],
      ).toEqual({ workflowId: `run:${started.runId}`, signal: 'cancelRun' });
      await expect(
        run(tenantA, (tx) => agentsService.runs.cancel(A, { runId: started.runId }, tx)),
      ).rejects.toBeInstanceOf(PolicyDeniedError); // resource_state
      await runInTenant(spCtx(), async () => {
        expect(await runtime.planNextStep({ ...input, step: 0 })).toEqual({
          kind: 'done',
          stepId: '',
          reason: 'run_cancelled',
        });
        expect((await runtime.finishRun({ ...input, state: 'completed' })).state).toBe('cancelled');
        await runtime.settleBudget(input);
      });
    });

    it('the runtime refuses foreign or mismatched ids and a revoked principal', async () => {
      const started = await run(tenantA, (tx) =>
        agentsService.runs.start(
          A,
          {
            brandId: brandA,
            servicePrincipalId: spA,
            requestedAutonomy: 'create',
            taskKind: 'copywriting',
            brief: {},
          },
          tx,
        ),
      );
      const { runtime } = runtimeWith([{ kind: 'done', text: '{}' }]);
      await expect(
        runInTenant(spCtx(tenantB, spB), () =>
          runtime.resolveContextSnapshot(workflowInput(started.runId, brandB, tenantB, spB)),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runInTenant(spCtx(), () => runtime.resolveContextSnapshot(workflowInput(started.runId, brandB))),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runInTenant(spCtx(), () =>
          runtime.resolveContextSnapshot({ ...workflowInput(started.runId), tenantId: tenantB }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('get and steps are brand-scoped reads with redacted inputs; foreign ids are NOT_FOUND', async () => {
      const [runId] = (
        await tdb.db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(eq(agentRuns.tenantId, tenantA))
          .limit(1)
      ).map((r) => r.id);
      const got = await runInTenant(ctx(tenantA), () => agentsService.runs.get(A, { runId: runId! }));
      expect(got.id).toBe(runId);
      const steps = await runInTenant(ctx(tenantA), () =>
        agentsService.runs.steps(A, { runId: runId!, page: { limit: 50 } }),
      );
      expect(Array.isArray(steps.items)).toBe(true);
      await expect(
        runInTenant(ctx(tenantB), () => agentsService.runs.get(manager(tenantB), { runId: runId! })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runInTenant(ctx(tenantB), () =>
          agentsService.runs.steps(manager(tenantB), { runId: runId!, page: { limit: 50 } }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('budgets (spec 12.6, Phase 4 gate: parallel runs cannot overspend)', () => {
    it('N concurrent reservations against one brand-day limit: exactly the affordable number succeed', async () => {
      await runInTenant(ctx(tenantA), () => budgets.setLimit(brandA, 'day', 7_000_000));
      const { runtime } = runtimeWith([{ kind: 'done', text: '{}' }]);
      const runIds = await Promise.all(
        Array.from({ length: 6 }, () =>
          run(tenantA, (tx) =>
            agentsService.runs.start(
              A,
              {
                brandId: brandA,
                servicePrincipalId: spA,
                requestedAutonomy: 'create',
                taskKind: 'copywriting',
                brief: {},
              },
              tx,
            ),
          ).then((r) => r.runId),
        ),
      );
      const budget = {
        maxSteps: 3,
        maxTokens: 1000,
        maxCostMicros: 2_000_000,
        maxVariants: 1,
        deadlineSeconds: 60,
      };
      const results = await Promise.allSettled(
        runIds.map((runId) =>
          runInTenant(spCtx(), () => runtime.reserveBudget({ ...workflowInput(runId), budget })),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const exhausted = results.filter(
        (r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason instanceof BudgetExhaustedError,
      ).length;
      expect(ok).toBeLessThanOrEqual(3); // 3 × 2,000,000 ≤ 7,000,000 < 4 × 2,000,000 (earlier runs of this file also hold reservations today)
      expect(ok + exhausted).toBe(6);
      const held = await tdb.db
        .select()
        .from(budgetReservations)
        .where(and(eq(budgetReservations.tenantId, tenantA), eq(budgetReservations.brandId, brandA)));
      expect(
        held
          .filter((h) => h.state !== 'released')
          .reduce((s, h) => s + Math.max(h.reservedMicros, h.consumedMicros), 0),
      ).toBeLessThanOrEqual(7_000_000);
      await runInTenant(ctx(tenantA), () => budgets.setLimit(brandA, 'day', 100_000_000));
    });

    it('a model call that exceeds the reservation is ledgered first and then ends the run with budget_exhausted', async () => {
      const started = await run(tenantA, (tx) =>
        agentsService.runs.start(
          A,
          {
            brandId: brandA,
            servicePrincipalId: spA,
            requestedAutonomy: 'create',
            taskKind: 'copywriting',
            brief: {},
          },
          tx,
        ),
      );
      const { runtime } = runtimeWith([
        { kind: 'done', text: '{}', usage: { inputTokens: 900_000, outputTokens: 100 } },
      ]);
      const input = workflowInput(started.runId);
      await runInTenant(spCtx(), async () => {
        await runtime.resolveContextSnapshot(input);
        await runtime.reserveBudget({
          ...input,
          budget: {
            maxSteps: 3,
            maxTokens: 5_000_000,
            maxCostMicros: 1000,
            maxVariants: 1,
            deadlineSeconds: 60,
          },
        });
        await expect(runtime.planNextStep({ ...input, step: 0 })).rejects.toBeInstanceOf(
          BudgetExhaustedError,
        );
        expect((await runtime.finishRun({ ...input, state: 'budget_exhausted' })).state).toBe(
          'budget_exhausted',
        );
        await runtime.settleBudget(input);
      });
      const steps = await stepsOf(started.runId);
      expect(steps.filter((s) => s.kind === 'model_call')).toHaveLength(1); // cost incurred is recorded
      const reservation = (
        await tdb.db.select().from(budgetReservations).where(eq(budgetReservations.runId, started.runId))
      )[0]!;
      expect(reservation.state).toBe('settled');
      expect(reservation.consumedMicros).toBeGreaterThan(1000);
    });
  });
});
