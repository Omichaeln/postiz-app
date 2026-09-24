import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  defaultPolicyDocument,
  emptyBrandSystemDocument,
  type BrandSystemDocumentV1,
} from '@oremedia/contracts/brand';
import type { CompareRankingInputV1 } from '@oremedia/contracts/intelligence';
import type { ResolvedActor, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { ResolvedSkill } from '@oremedia/contracts/skills';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, servicePrincipals, tenants, users } from '@oremedia/db/schema/access';
import { agentRuns } from '@oremedia/db/schema/agents';
import { brands } from '@oremedia/db/schema/brand';
import { briefs } from '@oremedia/db/schema/content';
import { experimentResults, experiments } from '@oremedia/db/schema/experiments';
import { insights, learningRecords, recommendations } from '@oremedia/db/schema/intelligence';
import { featureFlags } from '@oremedia/db/schema/operations';
import {
  registerSkillResolver,
  resetSkillResolver,
  resetRoutingPolicies,
  setTenantRoutingPolicy,
} from '@oremedia/ai';
import { createBaselineComparisonActivities } from '@oremedia/activities';
import { configureAgentModel } from '@oremedia/module-agents';
import { brandService } from '@oremedia/module-brand';
import { contentService } from '@oremedia/module-content';
import { experimentsService } from '@oremedia/module-experiments';
import {
  createIntelligenceRuntime,
  intelligenceService,
  registerAnalystTargetSource,
} from '@oremedia/module-intelligence';
import { runBaselineComparison } from '@oremedia/workflows/baseline-comparison.workflow.v1';
import { composeModules } from './composition';

/**
 * Phase 6 gate (spec 22): one recommendation flows to a brief, a variant and an experiment, and its learning record
 * closes end to end (context → evidence → hypothesis → action → decision → executed revision → outcome → verdict)
 * against MySQL, with the real modules composed as worker-core composes them (the experiments module reached
 * through the intelligence hooks, the verdict from the domain statistics); and the baseline comparison job runs
 * through the real activity host and records the fallback.
 */
/** Prefixed ids of the spec's shape without a domain import (apps never depend on the domain package). */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

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
const skill = (allowedTools: string[]): ResolvedSkill => ({
  skillVersionId: 'sv_01HTESTSKILL0000000000000000',
  skillId: 'skl_01HTESTSKILL000000000000000',
  key: 'brand-copywriting',
  versionNumber: 1,
  manifest: {
    schemaVersion: 1,
    key: 'brand-copywriting',
    title: 'Copy',
    description: 'test',
    taskKinds: ['copywriting'],
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
  instructions: 'Write copy.',
  references: [],
});

describe('Phase 6 gate: recommendation → brief, variant, experiment and a closed learning record (worker-core composition)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const brandA = newId('brd');
  const spA = newId('sp');
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
  const grants = [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'insight.read', brandIds: 'all' },
    { action: 'insight.manage', brandIds: 'all' },
    { action: 'agent.start_run', brandIds: 'all' },
    { action: 'experiment.manage', brandIds: 'all' },
  ] as const;
  const analystPrincipal: ResolvedActorServicePrincipal = {
    kind: 'service_principal',
    id: spA,
    tenantId: tenantA,
    status: 'active',
    maxAutonomy: 'create',
    grants: [...grants],
  };
  const ctx = (actor: TenantContext['actor']): TenantContext => ({
    tenantId: tenantA,
    actor,
    brandIds: 'all',
    correlationId: 'corr_gate',
  });
  const asManager = <T>(fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx({ kind: 'user', id: manager.id }), () => withTransaction(fn));
  const asAnalyst = <T>(fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx({ kind: 'service_principal', id: spA }), () => withTransaction(fn));
  const recRow = async (id: string) =>
    (await tdb.db.select().from(recommendations).where(eq(recommendations.id, id)))[0]!;
  const learningRow = async (id: string) =>
    (await tdb.db.select().from(learningRecords).where(eq(learningRecords.recommendationId, id)))[0]!;

  async function agentRun() {
    const id = newId('run');
    await tdb.db.insert(agentRuns).values({
      id,
      tenantId: tenantA,
      brandId: brandA,
      initiatorKind: 'system',
      initiatorId: spA,
      servicePrincipalId: spA,
      autonomyMode: 'assist',
      taskKind: 'performance_review',
      brief: {},
      contextSnapshotHash: null,
      skillVersionIds: [],
      modelConfig: { provider: 'fake', model: 'fake-model' },
      state: 'completed',
      budgetReservationId: null,
      costMicros: 0,
      deadlineAt: new Date(Date.now() + 1800_000),
      workflowId: `run:${id}`,
      correlationId: 'corr_gate',
    });
    return id;
  }
  async function recommendation(suggestedAction: 'brief' | 'variant' | 'experiment', title: string) {
    const runId = await agentRun();
    return asAnalyst((tx) =>
      intelligenceService.recommendations.createFromRun(
        analystPrincipal,
        {
          brandId: brandA,
          runId,
          title,
          rationale: 'Question-led hooks drew more qualified enquiries',
          evidenceRefs: [],
          suggestedAction,
        },
        tx,
      ),
    );
  }
  /** Two content revisions of the brand through the content module (the experiment's control and treatment). */
  async function revision(text: string) {
    const pkg = await asManager((tx) =>
      contentService.packages.create(
        managerActor,
        {
          brandId: brandA,
          title: text,
          copy: { schemaVersion: 1, master: { text, factRefs: [] } },
          creativeDocumentIds: [],
        },
        tx,
      ),
    );
    return pkg.contentRevisionId;
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    composeModules();
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'Gate', slug: 'gate-' + tenantA.slice(-6).toLowerCase() });
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'Gate brand',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await tdb.db.insert(users).values({
      id: manager.id,
      email: `gate-${manager.id.slice(-6).toLowerCase()}@example.test`,
      name: 'Gate manager',
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
      name: 'analyst',
      grants: [...grants],
      maxAutonomy: 'create',
      status: 'active',
      createdByUserId: manager.id,
    });
    await tdb.db.insert(featureFlags).values({
      key: 'experiments.randomised',
      enabledDefault: false,
      targeting: { tenantIds: [tenantA] },
      owner: 'experiments',
      removalDate: new Date('2027-03-31T00:00:00Z'),
      successMetric: 'test',
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
    await asManager((tx) =>
      brandService.objectives.set(
        managerActor,
        {
          brandId: brandA,
          name: 'Qualified enquiries',
          primaryMetricKey: 'qualified_enquiries',
          guardrailMetricKeys: ['complaints'],
          activeFrom: '2026-01-01T00:00:00.000Z',
        },
        tx,
      ),
    );
    registerSkillResolver(async () => [skill(['brand.getSnapshot', 'facts.list'])]);
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

  it('a brief: accepted with a back-reference to the recommendation', async () => {
    const rec = await recommendation('brief', 'Brief the delivery question');
    const accepted = await asManager((tx) =>
      intelligenceService.recommendations.accept(
        managerActor,
        {
          recommendationId: rec.recommendationId,
          expectedVersion: 0,
          action: 'create_brief',
          brief: {
            audience: 'Clinic owners',
            message: 'Ask first',
            offerFactIds: [],
            channelConnectionIds: [],
          },
        },
        tx,
      ),
    );
    const brief = (await tdb.db.select().from(briefs).where(eq(briefs.id, accepted.downstreamId!)))[0]!;
    expect(brief.recommendationId).toBe(rec.recommendationId);
    expect(await learningRow(rec.recommendationId)).toMatchObject({
      humanDecision: 'accepted',
      action: 'create_brief',
    });
  });

  it('a variant: accepted as a copywriting run (through the agents module) that carries the recommendation', async () => {
    const rec = await recommendation('variant', 'Variant with the question hook');
    const accepted = await asManager((tx) =>
      intelligenceService.recommendations.accept(
        managerActor,
        {
          recommendationId: rec.recommendationId,
          expectedVersion: 0,
          action: 'generate_variants',
          servicePrincipalId: spA,
        },
        tx,
      ),
    );
    expect(accepted.downstreamType).toBe('agent_run');
    const run = (await tdb.db.select().from(agentRuns).where(eq(agentRuns.id, accepted.downstreamId!)))[0]!;
    expect(run).toMatchObject({ taskKind: 'copywriting', state: 'planned', servicePrincipalId: spA });
    expect(run.brief).toMatchObject({ recommendationId: rec.recommendationId });
  });

  it('an experiment: pre-registered and frozen, results against a changed design rejected, verdict from the statistics, learning record closed', async () => {
    const control = await revision('Our inverters come with a five-year warranty.');
    const treatment = await revision('How long should an inverter warranty be? Ours is five years.');
    const rec = await recommendation('experiment', 'Test the question-led hook');
    const before = await learningRow(rec.recommendationId);
    expect(before).toMatchObject({
      contextRef: expect.stringMatching(/^agent_run:/),
      hypothesis: expect.any(String),
      action: 'prepare_test',
      humanDecision: 'pending',
      verdict: 'pending',
    });
    expect(before.evidenceRef).toMatch(/^insights:ins_/);

    // human decision → experiment draft (the experiments module, reached through the intelligence hook)
    const accepted = await asManager((tx) =>
      intelligenceService.recommendations.accept(
        managerActor,
        {
          recommendationId: rec.recommendationId,
          expectedVersion: 0,
          action: 'prepare_test',
          experimentDesign: {
            v: 1,
            hypothesis: 'A question-led hook raises the qualified enquiry rate per click',
            mode: 'randomised',
            variants: [
              { label: 'control', contentRevisionId: control, allocationWeight: 1 },
              { label: 'question_hook', contentRevisionId: treatment, allocationWeight: 1 },
            ],
            primaryMetricKey: 'qualified_enquiries',
            guardrailMetricKeys: ['complaints'],
            guardrailThresholds: { complaints: 0.05 },
            guardrailDirections: { complaints: 'up' },
            allocationMethod: 'hashed_visitor',
            unitType: 'visitor',
            minSamplePerArm: 200,
            observationWindowHours: 24,
            stoppingRule: { kind: 'fixed_horizon', alpha: 0.05 },
          },
        },
        tx,
      ),
    );
    expect(accepted.downstreamType).toBe('experiment');
    const experimentId = accepted.downstreamId!;
    expect(
      (await tdb.db.select().from(experiments).where(eq(experiments.id, experimentId)))[0],
    ).toMatchObject({ recommendationId: rec.recommendationId, state: 'designed' });

    // pre-registration freezes the design with its hash; the learning record cites it
    const pre = await asManager((tx) =>
      experimentsService.preRegister(managerActor, { experimentId, expectedVersion: 0 }, tx),
    );
    const frozen = (await tdb.db.select().from(experiments).where(eq(experiments.id, experimentId)))[0]!;
    expect(frozen.preRegistrationHash).toBe(pre.preRegistrationHash);
    expect(frozen.preRegistration).toMatchObject({
      v: 1,
      minSamplePerArm: 200,
      guardrailDirections: { complaints: 'up' },
    });
    expect((await learningRow(rec.recommendationId)).evidenceRef).toContain(
      `design:${pre.preRegistrationHash}`,
    );
    const started = await asManager((tx) =>
      experimentsService.start(managerActor, { experimentId, expectedVersion: pre.version }, tx),
    );
    expect(started.state).toBe('running');
    expect(await learningRow(rec.recommendationId)).toMatchObject({ executedRevisionId: treatment });
    expect((await recRow(rec.recommendationId)).state).toBe('executed');

    const experiment = await asManager((tx) => experimentsService.get(managerActor, { experimentId }, tx));
    const [c, t] = experiment.variants.map((v) => v.id);
    const at = new Date(Date.parse(experiment.startedAt!) + 25 * 3600_000).toISOString();
    const observations = [
      { variantId: c!, n: 1200, x: 60, exposure: 30_000, guardrails: { complaints: 12 } },
      { variantId: t!, n: 1150, x: 104, exposure: 29_100, guardrails: { complaints: 13 } },
    ];
    // results against a changed design are rejected: nothing is recorded
    await expect(
      asManager((tx) =>
        experimentsService.results(
          managerActor,
          { experimentId, preRegistrationHash: 'f'.repeat(64), observations, at },
          tx,
        ),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ path: 'preRegistrationHash', issue: 'design_changed' }],
    });
    expect(
      await tdb.db.select().from(experimentResults).where(eq(experimentResults.experimentId, experimentId)),
    ).toHaveLength(0);
    // and never before the window
    await expect(
      asManager((tx) =>
        experimentsService.results(
          managerActor,
          {
            experimentId,
            preRegistrationHash: pre.preRegistrationHash,
            observations,
            at: experiment.startedAt!,
          },
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // the verdict, from the domain two-proportion test with Holm and the guardrail rule
    const result = await asManager((tx) =>
      experimentsService.results(
        managerActor,
        { experimentId, preRegistrationHash: pre.preRegistrationHash, observations, at },
        tx,
      ),
    );
    expect(result).toMatchObject({
      verdict: 'supported',
      state: 'analysed',
      conclusionLabel: 'causal_when_sound',
      methodVersion: 'two_proportion_holm_v1',
    });
    expect(result.pValue).toBeLessThan(0.05);

    // THE CHAIN: context → evidence → hypothesis → action → decision → executed revision → outcome → verdict
    const chain = await learningRow(rec.recommendationId);
    expect(chain).toMatchObject({
      contextRef: before.contextRef,
      hypothesis: 'Question-led hooks drew more qualified enquiries',
      action: 'prepare_test',
      humanDecision: 'accepted',
      executedRevisionId: treatment,
      observedOutcomeRef: `experiment_result:${result.resultId}`,
      verdict: 'supported',
    });
    expect(chain.evidenceRef).toMatch(/^insights:ins_.*;design:[0-9a-f]{64}$/);
    const finding = (
      await tdb.db
        .select()
        .from(insights)
        .where(and(eq(insights.brandId, brandA), eq(insights.kind, 'experimental_finding')))
    )[0]!;
    expect(finding).toMatchObject({ strength: 'experimentally_supported' });
    expect(finding.evidence).toEqual(
      expect.arrayContaining([
        { kind: 'experiment_result', ref: result.resultId },
        { kind: 'recommendation', ref: rec.recommendationId },
      ]),
    );
    const workspace = await asManager((tx) =>
      intelligenceService.workspace.get(managerActor, { brandId: brandA }, tx),
    );
    expect(workspace.experiments.completed.map((x) => x.id)).toContain(experimentId);
    expect(workspace.whatWeLearned.experimentallySupported.map((i) => i.id)).toContain(finding.id);
  });

  it('the baseline comparison job runs through the activity host and records the fallback to the baseline', async () => {
    registerAnalystTargetSource(async () => [
      { tenantId: tenantA, brandId: brandA, servicePrincipalId: spA },
    ]);
    const runtime = createIntelligenceRuntime();
    const inputs: CompareRankingInputV1[] = [];
    const activities = createBaselineComparisonActivities({
      listBaselineTargets: runtime.baseline.listBaselineTargets,
      compareRankingBaseline: (input) => {
        inputs.push(input);
        return runtime.baseline.compareRankingBaseline(input);
      },
    });
    const summary = await runBaselineComparison(activities, {
      correlationId: 'baseline_gate',
      now: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(summary).toMatchObject({ compared: 1, failed: 0, fallbacks: 1 });
    expect(inputs[0]).toMatchObject({
      tenantId: tenantA,
      actor: { kind: 'service_principal', id: spA },
      brandId: brandA,
    });
    const result = summary.results[0]!;
    expect(result).toMatchObject({ brandId: brandA, beaten: false, selected: 'baseline' });
    expect(result.evaluated).toBeGreaterThanOrEqual(1);
    const stored = (await tdb.db.select().from(insights).where(eq(insights.id, result.insightId!)))[0]!;
    expect(stored.evidence[0]).toMatchObject({ kind: 'baseline_comparison', ref: 'baseline' });
    expect(stored.statement).toMatch(/baseline retained/);
    const ranked = await asAnalyst((tx) =>
      intelligenceService.recommendations.rank(analystPrincipal, { brandId: brandA }, tx),
    );
    expect(ranked.rankingPolicy).toBe('baseline');
  });
});
