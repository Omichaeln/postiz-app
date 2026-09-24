import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { AgentRunWorkflowInputV1 } from '@oremedia/contracts/agents';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { MetricValueV1 } from '@oremedia/contracts/measurement';
import type { ResolvedActor, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { ResolvedSkill } from '@oremedia/contracts/skills';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, servicePrincipals, tenants, users } from '@oremedia/db/schema/access';
import { agentRuns } from '@oremedia/db/schema/agents';
import { brandObjectives, brands } from '@oremedia/db/schema/brand';
import { briefs } from '@oremedia/db/schema/content';
import {
  customerVoiceClusters,
  insights,
  learningRecords,
  recommendations,
} from '@oremedia/db/schema/intelligence';
import { anomalies as anomalyRows } from '@oremedia/db/schema/intelligence';
import { featureFlags, outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import {
  FakeModelAdapter,
  createReleaseOneRegistry,
  modelConfigFromEnv,
  registerIntelligenceToolSource,
  registerSkillResolver,
  resetRoutingPolicies,
  resetSkillResolver,
  setTenantRoutingPolicy,
} from '@oremedia/ai';
import { emptyBrandSystemDocument, type BrandSystemDocumentV1 } from '@oremedia/contracts/brand';
import { MemoryTranscriptStore, configureAgentModel, createAgentRunRuntime } from '@oremedia/module-agents';
import { brandService } from '@oremedia/module-brand';
import { createIntelligenceRuntime } from './analyst';
import {
  registerExperimentDesigner,
  registerExperimentSource,
  registerMetricsSource,
  registerPublicationVolumeSource,
  resetExperimentDesigner,
  resetMetricsSource,
} from './hooks';
import { configureRanking, intelligenceService } from './service';
import { intelligenceToolSource } from './tools';
import { VERDICT_SCORE, compareRankings } from './ranking';
import { configureVoiceClassifier } from './voice';

interface Person {
  id: string;
  actor: ResolvedActor;
}

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

const value = (
  over: Partial<MetricValueV1> & { metricKey: string; value: number | null },
): MetricValueV1 => ({
  snapshotId: newId('metricSnapshot'),
  subjectType: 'publication',
  subjectId: newId('publication'),
  comparableGroup: 'organic',
  series: null,
  completeness: 'complete',
  freshness: { fetchedAt: '2026-09-24T01:00:00.000Z', ageHours: 2, latencyHours: 24, stale: false },
  source: 'fixture_provider:v1',
  definitionVersion: 1,
  windowStart: '2026-09-17T00:00:00.000Z',
  windowEnd: '2026-09-24T00:00:00.000Z',
  brandTimezone: 'UTC',
  numeratorSnapshotId: null,
  denominatorSnapshotId: null,
  ...over,
});

const skill = (allowedTools: string[]): ResolvedSkill => ({
  skillVersionId: 'sv_01HTESTSKILL0000000000000000',
  skillId: 'skl_01HTESTSKILL000000000000000',
  key: 'performance-review',
  versionNumber: 1,
  manifest: {
    schemaVersion: 1,
    key: 'performance-review',
    title: 'Performance review',
    description: 'test',
    taskKinds: ['performance_review', 'copywriting'],
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
  instructions: 'Review the period and propose.',
  references: [],
});

describe('intelligence module (spec 16) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA1 = newId('brand');
  const brandA2 = newId('brand');
  const brandB1 = newId('brand');
  const spA = newId('servicePrincipal');
  let manager: Person;
  let creator: Person;
  let managerB: Person;
  const principal = (tenantId: string, id: string): ResolvedActorServicePrincipal => ({
    kind: 'service_principal',
    id,
    tenantId,
    status: 'active',
    maxAutonomy: 'create',
    grants: [
      { action: 'brand.read', brandIds: 'all' },
      { action: 'insight.read', brandIds: 'all' },
      { action: 'insight.manage', brandIds: 'all' },
      { action: 'agent.start_run', brandIds: 'all' },
      { action: 'experiment.manage', brandIds: 'all' },
    ],
  });
  const designed: Array<{ recommendationId?: string; brandId: string; experimentId: string }> = [];
  const metricsByBrand = new Map<string, MetricValueV1[]>();
  let volume = 0;

  const ctx = (tenantId: string, actor: TenantContext['actor']): TenantContext => ({
    tenantId,
    actor,
    brandIds: 'all',
    correlationId: 'corr_intelligence',
  });
  const run = <T>(tenantId: string, actor: TenantContext['actor'], fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx(tenantId, actor), () => withTransaction(fn));
  const runA = <T>(fn: (tx: Tx) => Promise<T>) => run(tenantA, { kind: 'user', id: manager.id }, fn);
  const runSp = <T>(fn: (tx: Tx) => Promise<T>) => run(tenantA, { kind: 'service_principal', id: spA }, fn);
  const recRow = async (id: string) =>
    (await tdb.db.select().from(recommendations).where(eq(recommendations.id, id)))[0]!;
  const learningRow = async (recommendationId: string) =>
    (
      await tdb.db
        .select()
        .from(learningRecords)
        .where(eq(learningRecords.recommendationId, recommendationId))
    )[0]!;

  async function person(tenantId: string, label: string, role: 'brand_manager' | 'creator'): Promise<Person> {
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
  /** Agent runs resolve the brand's published version (spec 12.3): publish one through the brand module. */
  async function publishBrand(brandId: string, actor: ResolvedActor) {
    const r = <T>(fn: (tx: Tx) => Promise<T>) => run(actor.tenantId, { kind: 'user', id: actor.id }, fn);
    const draft = await r((tx) => brandService.versions.createDraft(actor, { brandId }, tx));
    await r((tx) =>
      brandService.versions.update(
        actor,
        { brandId, versionId: draft.versionId, expectedVersion: 0, document: brandDocument() },
        tx,
      ),
    );
    await r((tx) =>
      brandService.versions.submitForReview(
        actor,
        { brandId, versionId: draft.versionId, expectedVersion: 1 },
        tx,
      ),
    );
    await r((tx) =>
      brandService.versions.publish(actor, { brandId, versionId: draft.versionId, expectedVersion: 2 }, tx),
    );
  }
  async function objective(tenantId: string, brandId: string) {
    await tdb.db.insert(brandObjectives).values({
      id: newId('brandObjective'),
      tenantId,
      brandId,
      name: 'Qualified enquiries',
      primaryMetricKey: 'qualified_enquiries',
      guardrailMetricKeys: ['complaints'],
      activeFrom: new Date('2026-01-01T00:00:00Z'),
      activeUntil: null,
    });
  }
  /** A planned agent run row of the brand (this module never writes the agents tables; the row stands in for a run). */
  async function agentRun(tenantId: string, brandId: string, servicePrincipalId: string) {
    const id = newId('agentRun');
    await tdb.db.insert(agentRuns).values({
      id,
      tenantId,
      brandId,
      initiatorKind: 'system',
      initiatorId: servicePrincipalId,
      servicePrincipalId,
      autonomyMode: 'assist',
      taskKind: 'performance_review',
      brief: {},
      contextSnapshotHash: null,
      skillVersionIds: [],
      modelConfig: { provider: 'fake', model: 'fake-model' },
      state: 'running',
      budgetReservationId: null,
      costMicros: 0,
      deadlineAt: new Date(Date.now() + 1800_000),
      workflowId: `run:${id}`,
      correlationId: 'corr_intelligence',
    });
    return id;
  }
  async function recommendationFor(
    tenantId: string,
    brandId: string,
    sp: string,
    suggestedAction: 'brief' | 'variant' | 'experiment' | 'playbook_entry' = 'brief',
    title = 'Lead with the question',
  ) {
    const runId = await agentRun(tenantId, brandId, sp);
    return run(tenantId, { kind: 'service_principal', id: sp }, (tx) =>
      intelligenceService.recommendations.createFromRun(
        principal(tenantId, sp),
        {
          brandId,
          runId,
          title,
          rationale: 'Question-led hooks drew more qualified enquiries in the period',
          evidenceRefs: [],
          suggestedAction,
        },
        tx,
      ),
    );
  }

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'int-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'int-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA1, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB1, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    manager = await person(tenantA, 'manager', 'brand_manager');
    creator = await person(tenantA, 'creator', 'creator');
    managerB = await person(tenantB, 'manager-b', 'brand_manager');
    await tdb.db.insert(servicePrincipals).values({
      id: spA,
      tenantId: tenantA,
      kind: 'agent',
      name: 'analyst A',
      grants: [...principal(tenantA, spA).grants],
      maxAutonomy: 'create',
      status: 'active',
      createdByUserId: manager.id,
    });
    await objective(tenantA, brandA1);
    await objective(tenantB, brandB1);
    await publishBrand(brandA1, manager.actor);
    await tdb.db.insert(featureFlags).values({
      key: 'intelligence.brand_analyst',
      enabledDefault: false,
      targeting: { tenantIds: [tenantA] },
      owner: 'intelligence',
      removalDate: new Date('2027-03-31T00:00:00Z'),
      successMetric: 'test',
    });
    // Hooks the composition root wires in production: fakes here (the experiments and measurement modules are
    // reached through hooks only).
    registerExperimentDesigner(async (_actor, input) => {
      const experimentId = newId('experiment');
      designed.push({ recommendationId: input.recommendationId, brandId: input.brandId, experimentId });
      return { experimentId };
    });
    registerExperimentSource(async () => []);
    registerMetricsSource(async (_actor, query) => {
      const values = (metricsByBrand.get(query.brandId) ?? []).filter(
        (v) => v.windowStart >= query.windowStart && v.windowEnd <= query.windowEnd,
      );
      return {
        values,
        coverage: {
          subjectsRequested: values.length,
          subjectsWithData: values.length,
          metricsRequested: query.metricKeys,
          metricsWithData: [...new Set(values.map((v) => v.metricKey))],
          metricsUnavailable: query.metricKeys.filter((k) => !values.some((v) => v.metricKey === k)),
          staleValues: 0,
          windowStart: query.windowStart,
          windowEnd: query.windowEnd,
        },
      };
    });
    registerPublicationVolumeSource(async () => volume);
    registerIntelligenceToolSource(intelligenceToolSource);
    for (const t of [tenantA, tenantB])
      setTenantRoutingPolicy(t, {
        schemaVersion: 1,
        defaultModel: 'fake-model',
        permittedVendors: ['fake', 'anthropic'],
        permittedRegions: [],
        retention: 'standard_30d',
        dataClasses: ['brand_content', 'customer_voice'],
        deniedModels: [],
      });
    configureRanking({ policy: 'auto', explorationShare: 0.15, volumeThreshold: 30, baselineMargin: 0.05 });
  });
  afterAll(async () => {
    resetExperimentDesigner();
    resetMetricsSource();
    registerIntelligenceToolSource(null);
    resetRoutingPolicies();
    resetSkillResolver();
    configureAgentModel(null);
    configureVoiceClassifier(null);
    configureRanking(null);
    await tdb?.drop();
  });

  describe('objectives before ranking (spec 16.1)', () => {
    it('refuses to rank a brand without an active objective and says so in the list', async () => {
      const rec = await recommendationFor(tenantA, brandA2, spA);
      expect(rec.recommendationId).toMatch(/^rec_/);
      await expect(
        runSp((tx) =>
          intelligenceService.recommendations.rank(principal(tenantA, spA), { brandId: brandA2 }, tx),
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'brandId', issue: 'no_active_objective' }],
      });
      const list = await runA((tx) =>
        intelligenceService.recommendations.list(
          manager.actor,
          { brandId: brandA2, page: { limit: 50 } },
          tx,
        ),
      );
      expect(list.ranked).toBe(false);
      expect(list.items.map((r) => r.rank)).toEqual([0]);
      const workspace = await runA((tx) =>
        intelligenceService.workspace.get(manager.actor, { brandId: brandA2 }, tx),
      );
      expect(workspace.whatToDoNext.ranked).toBe(false);
      expect(workspace.whatToDoNext.statement).toMatch(/No active objective/);
    });

    it('ranks toward the objective with the baseline ranker, objective-aligned benefit first, then effort', async () => {
      const a = await recommendationFor(tenantA, brandA1, spA, 'brief', 'aligned, medium effort');
      const b = await recommendationFor(tenantA, brandA1, spA, 'variant', 'aligned, low effort');
      await tdb.db
        .update(recommendations)
        .set({ effort: 'low' })
        .where(eq(recommendations.id, b.recommendationId));
      const c = await recommendationFor(tenantA, brandA1, spA, 'brief', 'likes, low effort');
      await tdb.db
        .update(recommendations)
        .set({ effort: 'low', expectedBenefit: { metricKey: 'likes', direction: 'up' } })
        .where(eq(recommendations.id, c.recommendationId));
      const ranked = await runSp((tx) =>
        intelligenceService.recommendations.rank(principal(tenantA, spA), { brandId: brandA1 }, tx),
      );
      expect(ranked.rankingPolicy).toBe('baseline');
      expect(ranked.order.indexOf(b.recommendationId)).toBeLessThan(ranked.order.indexOf(a.recommendationId));
      expect(ranked.order.indexOf(a.recommendationId)).toBeLessThan(ranked.order.indexOf(c.recommendationId)); // likes never outrank the objective
      expect((await recRow(b.recommendationId)).rank).toBe(1);
    });
  });

  describe('recommendation actions (spec 16.4) and the learning chain (spec 16.8)', () => {
    it('a run creates the recommendation with its hypothesis insight and an open learning record', async () => {
      const rec = await recommendationFor(tenantA, brandA1, spA, 'experiment');
      const row = await recRow(rec.recommendationId);
      expect(row).toMatchObject({
        state: 'proposed',
        proposedAction: 'prepare_test',
        expectedBenefit: { metricKey: 'qualified_enquiries', direction: 'up' },
      });
      const hypothesis = (
        await tdb.db.select().from(insights).where(eq(insights.id, row.insightIds[0]!))
      )[0]!;
      expect(hypothesis).toMatchObject({
        kind: 'association',
        strength: 'observed',
        agentRunId: row.agentRunId,
      });
      expect(hypothesis.statement).toMatch(/^Hypothesis: /);
      expect(await learningRow(rec.recommendationId)).toMatchObject({
        contextRef: `agent_run:${row.agentRunId}`,
        evidenceRef: `insights:${row.insightIds.join(',')}`,
        action: 'prepare_test',
        humanDecision: 'pending',
        verdict: 'pending',
      });
      const dto = await runA((tx) =>
        intelligenceService.recommendations.get(
          manager.actor,
          { recommendationId: rec.recommendationId },
          tx,
        ),
      );
      expect(dto.actions).toEqual(['prepare_test', 'dismiss']); // exactly the relevant actions
    });

    it('accepting create_brief creates the brief with a back-reference and moves the chain to accepted', async () => {
      const rec = await recommendationFor(tenantA, brandA1, spA, 'brief');
      await expect(
        runA((tx) =>
          intelligenceService.recommendations.accept(
            manager.actor,
            { recommendationId: rec.recommendationId, expectedVersion: 0, action: 'prepare_test' },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'action', issue: 'action_not_offered' }] });
      await expect(
        runSp((tx) =>
          intelligenceService.recommendations.accept(
            principal(tenantA, spA),
            {
              recommendationId: rec.recommendationId,
              expectedVersion: 0,
              action: 'create_brief',
              brief: { audience: 'x', message: 'y', offerFactIds: [], channelConnectionIds: [] },
            },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError); // a person decides
      const accepted = await runA((tx) =>
        intelligenceService.recommendations.accept(
          manager.actor,
          {
            recommendationId: rec.recommendationId,
            expectedVersion: 0,
            action: 'create_brief',
            brief: {
              audience: 'Owners of small clinics',
              message: 'Ask the question first',
              offerFactIds: [],
              channelConnectionIds: [],
            },
          },
          tx,
        ),
      );
      expect(accepted).toMatchObject({ state: 'accepted', downstreamType: 'brief', version: 1 });
      const brief = (await tdb.db.select().from(briefs).where(eq(briefs.id, accepted.downstreamId!)))[0]!;
      expect(brief).toMatchObject({
        brandId: brandA1,
        recommendationId: rec.recommendationId,
        audience: 'Owners of small clinics',
        state: 'draft',
      });
      expect(await recRow(rec.recommendationId)).toMatchObject({
        state: 'accepted',
        decidedByUserId: manager.id,
        downstreamId: brief.id,
      });
      expect(await learningRow(rec.recommendationId)).toMatchObject({
        humanDecision: 'accepted',
        action: 'create_brief',
      });
    });

    it('accepting prepare_test designs the experiment through the hook; milestones close the chain with a verdict', async () => {
      const rec = await recommendationFor(tenantA, brandA1, spA, 'experiment');
      const accepted = await runA((tx) =>
        intelligenceService.recommendations.accept(
          manager.actor,
          {
            recommendationId: rec.recommendationId,
            expectedVersion: 0,
            action: 'prepare_test',
            experimentDesign: {
              v: 1,
              hypothesis: 'h',
              mode: 'randomised',
              variants: [
                { label: 'c', contentRevisionId: 'crev_c', allocationWeight: 1 },
                { label: 't', contentRevisionId: 'crev_t', allocationWeight: 1 },
              ],
              primaryMetricKey: 'qualified_enquiries',
              guardrailMetricKeys: [],
              allocationMethod: 'hashed_visitor',
              unitType: 'visitor',
              minSamplePerArm: 100,
              observationWindowHours: 24,
              stoppingRule: { kind: 'fixed_horizon' },
            },
          },
          tx,
        ),
      );
      expect(designed.at(-1)).toMatchObject({
        recommendationId: rec.recommendationId,
        brandId: brandA1,
        experimentId: accepted.downstreamId,
      });
      const base = {
        brandId: brandA1,
        experimentId: accepted.downstreamId!,
        recommendationId: rec.recommendationId,
        preRegistrationHash: 'e'.repeat(64),
        mode: 'randomised',
      };
      await runA((tx) =>
        intelligenceService.learning.onExperimentMilestone({ ...base, kind: 'pre_registered' }, tx),
      );
      await runA((tx) =>
        intelligenceService.learning.onExperimentMilestone(
          { ...base, kind: 'started', executedRevisionId: 'crev_t' },
          tx,
        ),
      );
      expect(await recRow(rec.recommendationId)).toMatchObject({ state: 'executed' });
      await runA((tx) =>
        intelligenceService.learning.onExperimentMilestone(
          {
            ...base,
            kind: 'analysed',
            resultId: 'xr_1',
            verdict: 'supported',
            verdictReason: 'primary_metric_improved',
          },
          tx,
        ),
      );
      const chain = await learningRow(rec.recommendationId);
      expect(chain).toMatchObject({
        humanDecision: 'accepted',
        action: 'prepare_test',
        executedRevisionId: 'crev_t',
        observedOutcomeRef: 'experiment_result:xr_1',
        verdict: 'supported',
      });
      expect(chain.evidenceRef).toContain('design:' + 'e'.repeat(64));
      const finding = (
        await tdb.db
          .select()
          .from(insights)
          .where(and(eq(insights.brandId, brandA1), eq(insights.kind, 'experimental_finding')))
      )[0]!;
      expect(finding).toMatchObject({ strength: 'experimentally_supported' });
      const learned = await runA((tx) =>
        intelligenceService.workspace.get(manager.actor, { brandId: brandA1 }, tx),
      );
      expect(learned.whatWeLearned.experimentallySupported.map((i) => i.id)).toContain(finding.id);
      expect(learned.whatWeLearned.observations.map((i) => i.id)).not.toContain(finding.id);
    });

    it('dismissal requires and stores a reason; the chain records a rejection, never an outcome', async () => {
      const rec = await recommendationFor(tenantA, brandA1, spA);
      const dismissed = await runA((tx) =>
        intelligenceService.recommendations.dismiss(
          manager.actor,
          {
            recommendationId: rec.recommendationId,
            expectedVersion: 0,
            reason: 'Off-brand for this quarter',
          },
          tx,
        ),
      );
      expect(dismissed.state).toBe('dismissed');
      expect(await recRow(rec.recommendationId)).toMatchObject({
        state: 'dismissed',
        dismissalReason: 'Off-brand for this quarter',
      });
      expect(await learningRow(rec.recommendationId)).toMatchObject({
        humanDecision: 'rejected',
        verdict: 'pending',
      });
      await expect(
        runA((tx) =>
          intelligenceService.recommendations.dismiss(
            manager.actor,
            { recommendationId: rec.recommendationId, expectedVersion: 1, reason: 'again' },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });
  });

  describe('playbook (spec 16.8)', () => {
    it('a proposal needs playbook.approve to become an approved practice; agents never approve', async () => {
      const rec = await recommendationFor(tenantA, brandA1, spA, 'playbook_entry');
      const accepted = await runA((tx) =>
        intelligenceService.recommendations.accept(
          manager.actor,
          {
            recommendationId: rec.recommendationId,
            expectedVersion: 0,
            action: 'propose_playbook_update',
            playbook: {
              practice: 'Open with the customer question',
              reviewAfter: '2027-03-01T00:00:00.000Z',
            },
          },
          tx,
        ),
      );
      expect(accepted.downstreamType).toBe('playbook_entry');
      const entryId = accepted.downstreamId!;
      await expect(
        run(tenantA, { kind: 'user', id: creator.id }, (tx) =>
          intelligenceService.playbook.approve(
            creator.actor,
            { playbookEntryId: entryId, expectedVersion: 0 },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'role_missing' });
      await expect(
        runSp((tx) =>
          intelligenceService.playbook.approve(
            principal(tenantA, spA),
            { playbookEntryId: entryId, expectedVersion: 0 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const before = await runA((tx) =>
        intelligenceService.workspace.get(manager.actor, { brandId: brandA1 }, tx),
      );
      expect(before.brandPlaybook.items.map((p) => p.id)).not.toContain(entryId);
      const approved = await runA((tx) =>
        intelligenceService.playbook.approve(
          manager.actor,
          { playbookEntryId: entryId, expectedVersion: 0 },
          tx,
        ),
      );
      expect(approved.state).toBe('approved');
      const after = await runA((tx) =>
        intelligenceService.workspace.get(manager.actor, { brandId: brandA1 }, tx),
      );
      expect(after.brandPlaybook.items.find((p) => p.id === entryId)).toMatchObject({
        strength: 'observed',
        approvedByUserId: manager.id,
        reviewAfter: '2027-03-01T00:00:00.000Z',
      });
      await expect(
        run(tenantB, { kind: 'user', id: managerB.id }, (tx) =>
          intelligenceService.playbook.approve(
            managerB.actor,
            { playbookEntryId: entryId, expectedVersion: 1 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('customer voice (spec 16.5)', () => {
    it('classifies with the configured model behind the routing policy, embeds per tenant and clusters per brand', async () => {
      const adapter = new FakeModelAdapter((req) => {
        const text = req.messages[0]?.content[0];
        const body = text?.type === 'text' ? text.text : '';
        return {
          kind: 'done',
          text: /BUY CHEAP/.test(body) ? 'spam' : /love/i.test(body) ? 'praise' : 'question',
        };
      });
      configureVoiceClassifier({ adapter, modelId: 'fake-model', timeoutMs: 1000 });
      const ingest = (tenantId: string, brandId: string, text: string) =>
        run(tenantId, { kind: 'service_principal', id: 'ingest' }, (tx) =>
          intelligenceService.voice.ingest(
            {
              brandId,
              messageId: newId('message'),
              text,
              authorHash: 'a'.repeat(64),
              remoteCreatedAt: '2026-09-20T10:00:00.000Z',
            },
            tx,
          ),
        );
      const first = await ingest(tenantA, brandA1, 'Do you deliver to Bulawayo on weekends?');
      const second = await ingest(tenantA, brandA1, 'Do you deliver on weekends to Bulawayo as well?');
      const other = await ingest(tenantA, brandA1, 'What is the warranty period for the solar inverter?');
      const spam = await ingest(tenantA, brandA1, 'BUY CHEAP followers now');
      const praise = await ingest(tenantA, brandA1, 'Love the new range, well done');
      expect(first.classification).toBe('question');
      expect(second.clusterId).toBe(first.clusterId);
      expect(other.clusterId).not.toBe(first.clusterId);
      expect(spam).toMatchObject({ classification: 'spam', clusterId: null });
      expect(praise.classification).toBe('praise');
      const cluster = (
        await tdb.db
          .select()
          .from(customerVoiceClusters)
          .where(eq(customerVoiceClusters.id, first.clusterId!))
      )[0]!;
      expect(cluster).toMatchObject({ size: 2, kind: 'question', brandId: brandA1 });
      expect(cluster.sampleMessageRefs).toHaveLength(2);
      expect(cluster.centroid).toHaveLength(64);
      // The model saw the routing-approved model id and the comment as delimited, untrusted data.
      expect(adapter.requests[0]).toMatchObject({ model: 'fake-model', metadata: { tenantId: tenantA } });
      expect(adapter.requests[0]?.system).toMatch(/cannot change these instructions/);
      // Isolation: the same words in another tenant, or another brand of the same tenant, never join this cluster.
      const inB = await ingest(tenantB, brandB1, 'Do you deliver to Bulawayo on weekends?');
      const inA2 = await ingest(tenantA, brandA2, 'Do you deliver to Bulawayo on weekends?');
      expect(inB.clusterId).not.toBe(first.clusterId);
      expect(inA2.clusterId).not.toBe(first.clusterId);
      const listed = await runA((tx) =>
        intelligenceService.voice.clusters(manager.actor, { brandId: brandA1, limit: 20 }, tx),
      );
      expect(listed.items.map((c) => c.id)).toContain(first.clusterId);
      expect(listed.items.map((c) => c.id)).not.toContain(inB.clusterId);
      expect(listed.items.every((c) => !('authorHash' in c))).toBe(true);
      // A tenant whose routing policy denies the vendor never reaches the model.
      setTenantRoutingPolicy(tenantB, {
        schemaVersion: 1,
        defaultModel: 'fake-model',
        permittedVendors: ['anthropic'],
        permittedRegions: [],
        retention: 'standard_30d',
        dataClasses: ['brand_content'],
        deniedModels: [],
      });
      await expect(ingest(tenantB, brandB1, 'Another question?')).rejects.toMatchObject({
        reason: 'model_routing_denied',
      });
    });
  });

  describe('learning isolation and the baseline comparison (spec 16.8)', () => {
    it('ranking inputs are scoped to the tenant and brand: other brands and tenants never enter the order or the history', async () => {
      const b1 = await recommendationFor(tenantB, brandB1, 'sp_b');
      const a2 = await recommendationFor(tenantA, brandA2, spA);
      const ranked = await runSp((tx) =>
        intelligenceService.recommendations.rank(principal(tenantA, spA), { brandId: brandA1 }, tx),
      );
      expect(ranked.order).not.toContain(b1.recommendationId);
      expect(ranked.order).not.toContain(a2.recommendationId);
      const rows = await tdb.db.select().from(recommendations).where(eq(recommendations.tenantId, tenantB));
      expect(rows.map((r) => r.rank)).toEqual([0]); // untouched
      await expect(
        run(tenantB, { kind: 'user', id: managerB.id }, (tx) =>
          intelligenceService.recommendations.get(managerB.actor, { recommendationId: ranked.order[0]! }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      const clustersB = await tdb.db
        .select()
        .from(customerVoiceClusters)
        .where(eq(customerVoiceClusters.tenantId, tenantB));
      expect(clustersB.every((c) => c.brandId === brandB1)).toBe(true);
    });

    it('the monthly comparison scores learned vs baseline on observed outcomes, records the fallback and the ranker obeys it', async () => {
      // Two closed loops in the period: an experiment-backed win on the objective and a not-supported one.
      const good = await recommendationFor(tenantA, brandA1, spA, 'experiment', 'good');
      const bad = await recommendationFor(tenantA, brandA1, spA, 'variant', 'bad');
      for (const [rec, verdict] of [
        [good, 'supported'],
        [bad, 'not_supported'],
      ] as const) {
        await tdb.db
          .update(recommendations)
          .set({ state: 'executed', decidedByUserId: manager.id })
          .where(eq(recommendations.id, rec.recommendationId));
        await tdb.db
          .update(learningRecords)
          .set({ humanDecision: 'accepted', verdict, observedOutcomeRef: 'experiment_result:x' })
          .where(eq(learningRecords.recommendationId, rec.recommendationId));
      }
      const result = await runSp((tx) =>
        intelligenceService.learning.compareRankingBaseline(
          principal(tenantA, spA),
          {
            brandId: brandA1,
            periodStart: new Date(Date.now() - 30 * 86_400_000),
            periodEnd: new Date(Date.now() + 60_000),
          },
          tx,
        ),
      );
      expect(result.evaluated).toBeGreaterThanOrEqual(2); // this brand's closed loops in the period
      expect(result.baselineScore).not.toBeNull();
      expect(result.learnedScore).not.toBeNull();
      expect(result.selected).toBe(result.beaten ? 'learned' : 'baseline');
      const stored = (await tdb.db.select().from(insights).where(eq(insights.id, result.insightId)))[0]!;
      expect(stored.kind).toBe('association');
      expect(stored.evidence[0]).toMatchObject({ kind: 'baseline_comparison', ref: result.selected });
      expect(stored.statement).toMatch(result.beaten ? /learned ranking beats/ : /baseline retained/);
      // The comparison insight is a ranking record, not a learning shown to people.
      const workspace = await runA((tx) =>
        intelligenceService.workspace.get(manager.actor, { brandId: brandA1 }, tx),
      );
      expect(workspace.whatWeLearned.observations.map((i) => i.id)).not.toContain(result.insightId);
      expect(workspace.whatToDoNext.rankingPolicy).toBe(result.selected);
      const ranked = await runSp((tx) =>
        intelligenceService.recommendations.rank(principal(tenantA, spA), { brandId: brandA1 }, tx),
      );
      expect(ranked.rankingPolicy).toBe(result.selected);
      // A second comparison supersedes the first.
      const again = await runSp((tx) =>
        intelligenceService.learning.compareRankingBaseline(
          principal(tenantA, spA),
          {
            brandId: brandA1,
            periodStart: new Date(Date.now() - 30 * 86_400_000),
            periodEnd: new Date(Date.now() + 60_000),
          },
          tx,
        ),
      );
      expect((await tdb.db.select().from(insights).where(eq(insights.id, result.insightId)))[0]!.state).toBe(
        'superseded',
      );
      expect((await tdb.db.select().from(insights).where(eq(insights.id, again.insightId)))[0]!.state).toBe(
        'active',
      );
    });

    it('the comparison never learns from the verdicts it scores: with every closed loop in the period, learned scores as with no history', async () => {
      // Created in this order the id tie-break puts the losing recommendation first, so a ranker that had seen
      // the period's verdicts would put the winner first and score a perfect ordering.
      const asB = <T>(fn: (tx: Tx) => Promise<T>) =>
        run(tenantB, { kind: 'service_principal', id: 'sp_b' }, fn);
      const loser = await recommendationFor(tenantB, brandB1, 'sp_b', 'variant', 'loser');
      const winner = await recommendationFor(tenantB, brandB1, 'sp_b', 'experiment', 'winner');
      for (const [rec, verdict] of [
        [loser, 'not_supported'],
        [winner, 'supported'],
      ] as const) {
        await tdb.db
          .update(recommendations)
          .set({ state: 'executed', decidedByUserId: managerB.id })
          .where(eq(recommendations.id, rec.recommendationId));
        await tdb.db
          .update(learningRecords)
          .set({ humanDecision: 'accepted', verdict, observedOutcomeRef: 'experiment_result:x' })
          .where(eq(learningRecords.recommendationId, rec.recommendationId));
      }
      const result = await asB((tx) =>
        intelligenceService.learning.compareRankingBaseline(
          principal(tenantB, 'sp_b'),
          {
            brandId: brandB1,
            periodStart: new Date(Date.now() - 30 * 86_400_000),
            periodEnd: new Date(Date.now() + 60_000),
          },
          tx,
        ),
      );
      const rows = await tdb.db.select().from(recommendations).where(eq(recommendations.brandId, brandB1));
      const items = rows
        .filter((r) => r.state === 'executed')
        .map((r) => ({
          id: r.id,
          proposedAction: r.proposedAction,
          expectedBenefit: r.expectedBenefit,
          effort: r.effort,
          uncertainty: r.uncertainty,
        }));
      const outcomes = new Map([
        [loser.recommendationId, VERDICT_SCORE.not_supported],
        [winner.recommendationId, VERDICT_SCORE.supported],
      ]);
      const noHistory = compareRankings(
        items,
        { primaryMetricKey: 'qualified_enquiries', guardrailMetricKeys: ['complaints'] },
        [],
        outcomes,
        result.margin,
      );
      expect(result.evaluated).toBe(2);
      expect(noHistory.learnedScore).toBeLessThan(1);
      expect(result.learnedScore).toBe(noHistory.learnedScore);
      expect(result.selected).toBe('baseline');
    });

    it('exploration reserves a share for untested actions once the brand has the volume', async () => {
      await recommendationFor(tenantA, brandA1, spA, 'playbook_entry', 'untested action');
      const before = await runSp((tx) =>
        intelligenceService.recommendations.rank(principal(tenantA, spA), { brandId: brandA1 }, tx),
      );
      expect(before.rankingPolicy).not.toBe('exploration'); // below the volume threshold nothing is explored
      volume = 60;
      const ranked = await runSp((tx) =>
        intelligenceService.recommendations.rank(principal(tenantA, spA), { brandId: brandA1 }, tx),
      );
      volume = 0;
      expect(ranked.rankingPolicy).toBe('exploration');
      expect(ranked.order[0]).toBe(before.order[0]); // the best-supported action keeps the top slot
      expect(ranked.order[1]).not.toBe(before.order[1]); // an untested approach the ranker buried moved up
      expect((await recRow(ranked.order[1]!)).rankingPolicy).toBe('exploration');
    });
  });

  describe('brand analyst runtime (spec 16.3)', () => {
    it('writes the movements, starts the performance-review run, the run proposes through recommendations.create, the outcome is ranked', async () => {
      const periodStart = '2026-09-17T00:00:00.000Z';
      const periodEnd = '2026-09-24T00:00:00.000Z';
      metricsByBrand.set(brandA1, [
        value({
          metricKey: 'qualified_enquiries',
          value: 30,
          windowStart: '2026-09-10T00:00:00.000Z',
          windowEnd: '2026-09-17T00:00:00.000Z',
        }),
        value({ metricKey: 'qualified_enquiries', value: 48 }),
        value({
          metricKey: 'complaints',
          value: 2,
          windowStart: '2026-09-10T00:00:00.000Z',
          windowEnd: '2026-09-17T00:00:00.000Z',
        }),
        value({ metricKey: 'complaints', value: 8, completeness: 'partial' }),
      ]);
      registerSkillResolver(async () => [
        skill(['brand.getSnapshot', 'metrics.query', 'voice.clusters', 'recommendations.create']),
      ]);
      const modelConfig = { ...modelConfigFromEnv({}), provider: 'fake', model: 'fake-model' };
      configureAgentModel(modelConfig);
      const runtime = createIntelligenceRuntime({ now: () => new Date(periodEnd) });
      const input = {
        tenantId: tenantA,
        actor: { kind: 'service_principal' as const, id: spA },
        correlationId: 'corr_analyst',
        brandId: brandA1,
        servicePrincipalId: spA,
        periodStart,
        periodEnd,
      };
      const prepared = await runInTenant(ctx(tenantA, { kind: 'service_principal', id: spA }), () =>
        runtime.analyst.prepareAnalysis(input),
      );
      expect(prepared.skippedReason).toBeNull();
      expect(prepared.runId).toMatch(/^run_|^ar_|^agr_/);
      expect(prepared.changeInsightIds).toHaveLength(2);
      expect(prepared.coverage.sources).toEqual(['qualified_enquiries', 'complaints']);
      // An activity retry with the same input reuses the movements and the run: one set of insights, one run.
      const retried = await runInTenant(ctx(tenantA, { kind: 'service_principal', id: spA }), () =>
        runtime.analyst.prepareAnalysis(input),
      );
      expect(retried).toEqual(prepared);
      const reviewRuns = (await tdb.db.select().from(agentRuns).where(eq(agentRuns.brandId, brandA1))).filter(
        (r) => r.taskKind === 'performance_review' && 'period' in r.brief,
      );
      expect(reviewRuns.map((r) => r.id)).toEqual([prepared.runId]);
      const movements = await tdb.db
        .select()
        .from(insights)
        .where(and(eq(insights.brandId, brandA1), eq(insights.periodEnd, new Date(periodEnd))));
      expect(movements.map((m) => m.id).sort()).toEqual([...prepared.changeInsightIds].sort());
      expect(movements.every((m) => m.evidence.at(-1)?.ref === prepared.runId)).toBe(true);
      const enquiries = movements.find((m) => m.statement.startsWith('qualified_enquiries'))!;
      expect(enquiries).toMatchObject({ kind: 'anomaly', strength: 'observed' });
      expect(enquiries.statement).toBe(
        'qualified_enquiries: 48 vs 30 previous period (+60.0%); fetched 2026-09-24T01:00:00.000Z',
      );
      const complaints = movements.find((m) => m.statement.startsWith('complaints'))!;
      expect(complaints.statement).toMatch(/partial coverage, not a trend/);
      expect(await tdb.db.select().from(anomalyRows).where(eq(anomalyRows.brandId, brandA1))).toHaveLength(2);
      const runRow = (await tdb.db.select().from(agentRuns).where(eq(agentRuns.id, prepared.runId!)))[0]!;
      expect(runRow).toMatchObject({
        taskKind: 'performance_review',
        autonomyMode: 'assist',
        servicePrincipalId: spA,
      });
      expect(runRow.brief).toMatchObject({
        metricKeys: ['qualified_enquiries', 'complaints'],
        period: { from: '2026-09-17', to: '2026-09-24' },
      });
      const requested = await tdb.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.aggregateId, prepared.runId!)));
      expect(requested.map((e) => e.eventType)).toContain('agent.run_requested');

      // The run itself (agentRunWorkflowV1 on queue agents) with a scripted model that queries and proposes.
      const adapter = new FakeModelAdapter([
        {
          kind: 'tool_calls',
          toolCalls: [
            {
              name: 'metrics.query',
              arguments: { metricKeys: ['qualified_enquiries'], from: periodStart, to: periodEnd },
            },
            { name: 'voice.clusters', arguments: { limit: 5 } },
          ],
        },
        {
          kind: 'tool_calls',
          toolCalls: [
            {
              name: 'recommendations.create',
              arguments: {
                title: 'Lead with the delivery question',
                rationale: 'Enquiries rose with question-led posts',
                evidenceRefs: [prepared.changeInsightIds[0]!, 'cluster:delivery'],
                suggestedAction: 'experiment',
              },
            },
          ],
        },
        { kind: 'done', text: '{"insights":[],"recommendations":[],"findings":[]}' },
      ]);
      const agents = createAgentRunRuntime({
        adapter,
        modelConfig,
        registry: createReleaseOneRegistry(),
        transcripts: new MemoryTranscriptStore(),
      });
      const wf: AgentRunWorkflowInputV1 = {
        tenantId: tenantA,
        actor: { kind: 'service_principal', id: spA },
        correlationId: 'corr_analyst',
        runId: prepared.runId!,
        brandId: brandA1,
      };
      const spCtx = ctx(tenantA, { kind: 'service_principal', id: spA });
      const results: string[] = [];
      await runInTenant(spCtx, async () => {
        const context = await agents.resolveContextSnapshot(wf);
        expect(context.allowedTools).toEqual([
          'brand.getSnapshot',
          'metrics.query',
          'recommendations.create',
          'voice.clusters',
        ]);
        await agents.reserveBudget({ ...wf, budget: context.budget });
        for (let step = 0; step < 6; step++) {
          const next = await agents.planNextStep({ ...wf, step }, { heartbeat: () => undefined });
          if (next.kind === 'done') break;
          for (const call of next.toolCalls)
            results.push((await agents.dispatchTool({ ...wf, step, stepId: next.stepId, call })).kind);
        }
        await agents.finishRun({ ...wf, state: 'completed' });
        await agents.settleBudget(wf);
      });
      expect(results).toEqual(['ok', 'ok', 'ok']);
      const proposed = (
        await tdb.db.select().from(recommendations).where(eq(recommendations.agentRunId, prepared.runId!))
      )[0]!;
      expect(proposed).toMatchObject({
        proposedAction: 'prepare_test',
        state: 'proposed',
        title: 'Lead with the delivery question',
      });
      expect(proposed.insightIds).toContain(prepared.changeInsightIds[0]);
      const read = await runInTenant(spCtx, () =>
        runtime.analyst.readAnalystRun({ ...input, runId: prepared.runId! }),
      );
      expect(read).toEqual({ state: 'completed', terminal: true });
      const recorded = await runInTenant(spCtx, () =>
        runtime.analyst.recordAnalystOutcome({
          ...input,
          runId: prepared.runId!,
          runState: 'completed',
          changeInsightIds: prepared.changeInsightIds,
        }),
      );
      expect(recorded).toMatchObject({ recommendations: 1, insights: 3 });
      expect((await recRow(proposed.id)).rank).toBeGreaterThan(0);
      const workspace = await runA((tx) =>
        intelligenceService.workspace.get(manager.actor, { brandId: brandA1 }, tx),
      );
      expect(workspace.whatChanged.items.map((i) => i.id)).toEqual(
        expect.arrayContaining(prepared.changeInsightIds),
      );
      expect(workspace.whatChanged.coverage.sources).toEqual(
        expect.arrayContaining(['qualified_enquiries', 'complaints']),
      );
      expect(workspace.whatChanged.freshness.asOf).toBe(periodEnd);
      expect(workspace.whatToDoNext.items.map((r) => r.id)).toContain(proposed.id);
    });

    it('skips without an objective, with the flag off, or without a metrics source, and never starts a run', async () => {
      const runtime = createIntelligenceRuntime();
      const base = {
        correlationId: 'corr_analyst',
        periodStart: '2026-09-17T00:00:00.000Z',
        periodEnd: '2026-09-24T00:00:00.000Z',
      };
      const noObjective = await runInTenant(ctx(tenantA, { kind: 'service_principal', id: spA }), () =>
        runtime.analyst.prepareAnalysis({
          ...base,
          tenantId: tenantA,
          actor: { kind: 'service_principal', id: spA },
          brandId: brandA2,
          servicePrincipalId: spA,
        }),
      );
      expect(noObjective).toMatchObject({
        runId: null,
        skippedReason: 'no_active_objective',
        changeInsightIds: [],
      });
      resetMetricsSource();
      const noMetrics = await runInTenant(ctx(tenantA, { kind: 'service_principal', id: spA }), () =>
        runtime.analyst.prepareAnalysis({
          ...base,
          tenantId: tenantA,
          actor: { kind: 'service_principal', id: spA },
          brandId: brandA1,
          servicePrincipalId: spA,
        }),
      );
      expect(noMetrics.skippedReason).toBe('metrics_source_not_registered');
      await expect(
        runA((tx) =>
          intelligenceService.analyst.run(
            manager.actor,
            { brandId: brandA1, servicePrincipalId: spA, periodDays: 7 },
            tx,
          ),
        ),
      ).resolves.toMatchObject({ workflowId: expect.stringMatching(/^brand-analyst:/) });
      const due = await tdb.db
        .select()
        .from(outboxEvents)
        .where(
          and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, 'intelligence.analysis_due')),
        );
      expect(due).toHaveLength(1);
      expect(due[0]!.payload).toMatchObject({ brandId: brandA1, servicePrincipalId: spA });
      const flagOff = await run(tenantB, { kind: 'user', id: managerB.id }, (tx) =>
        intelligenceService.analyst
          .run(managerB.actor, { brandId: brandB1, servicePrincipalId: 'sp_b', periodDays: 7 }, tx)
          .catch((e: unknown) => e),
      );
      expect(flagOff).toMatchObject({ reason: 'feature_flag_off' });
    });
  });
});
