import type { z } from 'zod';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import {
  AnalystRun,
  AnomalyList,
  InsightList,
  PlaybookApprove,
  PlaybookList,
  PlaybookPropose,
  RecommendationAccept,
  RecommendationDismiss,
  RecommendationGet,
  RecommendationList,
  VoiceClustersList,
  VoiceCommentInput,
  WorkspaceGet,
  type FreshnessStatement,
  type RankingPolicy,
  type RecommendationAction,
} from '@oremedia/contracts/intelligence';
import { ExperimentDesign } from '@oremedia/contracts/experiments';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { agentsService } from '@oremedia/module-agents';
import { brandService } from '@oremedia/module-brand';
import { contentService } from '@oremedia/module-content';
import { audit, featureFlag, outbox } from '@oremedia/module-operations';
import { experiments, experimentsForBrand, publicationVolume } from './hooks';
import {
  applyExploration,
  compareRankings,
  rankBaseline,
  rankLearned,
  rankingConfigFromEnv,
  VERDICT_SCORE,
  type OutcomeHistory,
  type Rankable,
  type RankingConfig,
  type RankingObjective,
} from './ranking';
import {
  AnomalyRepository,
  CustomerVoiceClusterRepository,
  InsightRepository,
  LearningRecordRepository,
  PlaybookEntryRepository,
  RecommendationRepository,
} from './repositories';
import {
  classifyComment,
  embedText,
  labelFor,
  nearestCluster,
  updatedCentroid,
  type MessageClassificationValue,
} from './voice';

const insightsRepo = new InsightRepository();
const recommendationsRepo = new RecommendationRepository();
const learningRepo = new LearningRecordRepository();
const playbookRepo = new PlaybookEntryRepository();
const clustersRepo = new CustomerVoiceClusterRepository();
const anomaliesRepo = new AnomalyRepository();

type InsightRow = Awaited<ReturnType<typeof insightsRepo.getById>>;
type RecommendationRow = Awaited<ReturnType<typeof recommendationsRepo.getById>>;
type LearningRow = Awaited<ReturnType<typeof learningRepo.getById>>;
type PlaybookRow = Awaited<ReturnType<typeof playbookRepo.getById>>;
type ClusterRow = Awaited<ReturnType<typeof clustersRepo.getById>>;

/** The ranker in force is configuration; the monthly comparison can still force the baseline (spec 16.8). */
let rankingConfig: RankingConfig | null = null;
const currentRankingConfig = (): RankingConfig => (rankingConfig ??= rankingConfigFromEnv());
export const configureRanking = (cfg: RankingConfig | null): void => {
  rankingConfig = cfg;
};

/** Evidence entries of the ranking comparison insight (spec 16.8) are recognisable by this kind. */
export const BASELINE_COMPARISON_EVIDENCE = 'baseline_comparison';
const STALE_AFTER_HOURS = 24 * 8; // a weekly analysis older than a week plus a day

// ---- helpers ----

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
/**
 * A service principal doing scheduled work (the analyst) acts under its own autonomy ceiling: the policy engine
 * needs a mode for step 7 and the principal cannot exceed what it was granted. People need no mode.
 */
const policyOptions = (actor: ResolvedActor) =>
  actor.kind === 'service_principal' ? { autonomyMode: actor.maxAutonomy } : {};
const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const recommendationResource = (r: RecommendationRow) => ({
  type: 'recommendation',
  tenantId: r.tenantId,
  brandId: r.brandId,
  id: r.id,
  state: r.state,
});

/** Spec 16.4 tool actions → recommendation actions (the tool vocabulary is the model's, the row's is ours). */
export const ACTION_FOR_SUGGESTION: Record<
  'brief' | 'variant' | 'experiment' | 'playbook_entry',
  RecommendationAction
> = {
  brief: 'create_brief',
  variant: 'generate_variants',
  experiment: 'prepare_test',
  playbook_entry: 'propose_playbook_update',
};

const freshnessOf = (asOf: Date | null, now = new Date()): FreshnessStatement => {
  if (!asOf) return { asOf: null, ageHours: null, stale: true };
  const ageHours = Math.max(0, (now.getTime() - asOf.getTime()) / 3600_000);
  return {
    asOf: asOf.toISOString(),
    ageHours: Math.round(ageHours * 10) / 10,
    stale: ageHours > STALE_AFTER_HOURS,
  };
};
const newest = (dates: readonly (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null);

const toInsightDto = (i: InsightRow) => ({
  id: i.id,
  brandId: i.brandId,
  kind: i.kind,
  statement: i.statement,
  evidence: i.evidence,
  strength: i.strength,
  periodStart: i.periodStart.toISOString(),
  periodEnd: i.periodEnd.toISOString(),
  state: i.state,
  agentRunId: i.agentRunId,
  createdAt: i.createdAt.toISOString(),
  version: i.version,
});
/** Spec 16.4: exactly the relevant actions: the proposed one, and dismiss. */
const actionsFor = (r: RecommendationRow): Array<RecommendationAction | 'dismiss'> =>
  r.state === 'proposed' ? [r.proposedAction, 'dismiss'] : [];
const toRecommendationDto = (r: RecommendationRow, learning: LearningRow | null) => ({
  id: r.id,
  brandId: r.brandId,
  insightIds: r.insightIds,
  proposedAction: r.proposedAction,
  actions: actionsFor(r),
  title: r.title,
  rationale: r.rationale,
  expectedBenefit: r.expectedBenefit,
  effort: r.effort,
  uncertainty: r.uncertainty,
  rank: r.rank,
  rankingPolicy: r.rankingPolicy,
  state: r.state,
  dismissalReason: r.dismissalReason,
  decidedByUserId: r.decidedByUserId,
  downstreamType: r.downstreamType,
  downstreamId: r.downstreamId,
  agentRunId: r.agentRunId,
  learning: learning ? toLearningDto(learning) : null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  version: r.version,
});
const toLearningDto = (l: LearningRow) => ({
  id: l.id,
  recommendationId: l.recommendationId,
  contextRef: l.contextRef,
  evidenceRef: l.evidenceRef,
  hypothesis: l.hypothesis,
  action: l.action,
  humanDecision: l.humanDecision,
  executedRevisionId: l.executedRevisionId,
  observedOutcomeRef: l.observedOutcomeRef,
  verdict: l.verdict,
  updatedAt: l.updatedAt.toISOString(),
  version: l.version,
});
const toPlaybookDto = (p: PlaybookRow) => ({
  id: p.id,
  brandId: p.brandId,
  practice: p.practice,
  evidenceIds: p.evidenceIds,
  strength: p.strength,
  approvedByUserId: p.approvedByUserId,
  reviewAfter: p.reviewAfter.toISOString(),
  state: p.state,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  version: p.version,
});
/** Counts, sample message references and dates only: never a copy of an author identity (spec 16.5). */
const toClusterDto = (c: ClusterRow) => ({
  id: c.id,
  brandId: c.brandId,
  label: c.label,
  kind: c.kind,
  size: c.size,
  sampleMessageRefs: c.sampleMessageRefs,
  linkedRecommendationIds: c.linkedRecommendationIds,
  firstSeen: c.firstSeen.toISOString(),
  lastSeen: c.lastSeen.toISOString(),
  version: c.version,
});

const rankable = (r: RecommendationRow): Rankable => ({
  id: r.id,
  proposedAction: r.proposedAction,
  expectedBenefit: r.expectedBenefit,
  effort: r.effort,
  uncertainty: r.uncertainty,
});

/** Spec 16.1 mandatory baseline: no ranking without an active objective. */
async function activeObjective(
  actor: ResolvedActor,
  brandId: string,
  tx?: Tx,
): Promise<RankingObjective | null> {
  const page = await brandService.objectives.list(
    actor,
    { brandId, activeOnly: true, page: { limit: 1 } },
    tx,
  );
  const o = page.items[0];
  return o ? { primaryMetricKey: o.primaryMetricKey, guardrailMetricKeys: o.guardrailMetricKeys } : null;
}
function requireObjective(objective: RankingObjective | null): RankingObjective {
  if (!objective)
    throw new ValidationFailedError(
      [{ path: 'brandId', issue: 'no_active_objective' }],
      'Define the brand objective before recommendations are ranked',
    );
  return objective;
}

/**
 * The brand's own closed loops (tenant and brand scoped by the repository): the only history a ranker sees. With
 * `decidedBefore`, only recommendations decided before that moment count, so a comparison never scores a period
 * with a ranker that already knows the period's outcomes.
 */
async function outcomeHistory(brandId: string, tx?: Tx, decidedBefore?: Date): Promise<OutcomeHistory[]> {
  const records = await learningRepo.listWithVerdict(brandId, tx);
  const decided = decidedBefore
    ? await recommendationsRepo.listDecidedBefore(brandId, decidedBefore, tx)
    : await recommendationsRepo.listDecided(brandId, tx);
  const recs = new Map(decided.map((r) => [r.id, r]));
  const out: OutcomeHistory[] = [];
  for (const l of records) {
    const r = recs.get(l.recommendationId);
    if (!r || l.verdict === 'pending') continue;
    out.push({ action: l.action, metricKey: r.expectedBenefit.metricKey, verdict: l.verdict });
  }
  return out;
}

/** The ranker the last baseline comparison selected for this brand (`auto`), else the configured one. */
async function rankerFor(brandId: string, tx?: Tx): Promise<RankingPolicy> {
  const cfg = currentRankingConfig();
  if (cfg.policy !== 'auto') return cfg.policy;
  const comparisons = (await insightsRepo.listActive(brandId, ['association'], tx)).filter((i) =>
    i.evidence.some((e) => e.kind === BASELINE_COMPARISON_EVIDENCE),
  );
  const latest = comparisons[0];
  if (!latest) return 'baseline';
  const selected = latest.evidence.find((e) => e.kind === BASELINE_COMPARISON_EVIDENCE)?.ref;
  return selected === 'learned' ? 'learned' : 'baseline';
}

async function learningFor(r: RecommendationRow, tx: Tx): Promise<LearningRow> {
  const l = await learningRepo.findForRecommendation(r.brandId, r.id, tx);
  if (!l) throw new NotFoundError('LearningRecord', r.id);
  return l;
}

/** Spec 16.8: every recommendation starts its chain (context → evidence → hypothesis → action) when it is created. */
async function createRecommendationWithChain(
  actor: ResolvedActor,
  input: {
    brandId: string;
    insightIds: string[];
    proposedAction: RecommendationAction;
    title: string;
    rationale: string;
    expectedBenefit: { metricKey: string; direction: 'up' | 'down'; magnitude?: string };
    effort: 'low' | 'medium' | 'high';
    uncertainty: 'low' | 'medium' | 'high';
    agentRunId: string | null;
    contextRef: string;
  },
  tx: Tx,
) {
  const id = newId('recommendation');
  await recommendationsRepo.create(
    {
      id,
      brandId: input.brandId,
      insightIds: input.insightIds,
      proposedAction: input.proposedAction,
      title: input.title.slice(0, 200),
      rationale: input.rationale,
      expectedBenefit: input.expectedBenefit,
      effort: input.effort,
      uncertainty: input.uncertainty,
      rank: 0,
      rankingPolicy: 'baseline',
      state: 'proposed',
      dismissalReason: null,
      decidedByUserId: null,
      downstreamType: null,
      downstreamId: null,
      agentRunId: input.agentRunId,
    },
    tx,
  );
  await learningRepo.create(
    {
      id: newId('learningRecord'),
      brandId: input.brandId,
      recommendationId: id,
      contextRef: input.contextRef.slice(0, 200),
      evidenceRef: `insights:${input.insightIds.join(',')}`.slice(0, 200),
      hypothesis: input.rationale,
      action: input.proposedAction,
      humanDecision: 'pending',
      executedRevisionId: null,
      observedOutcomeRef: null,
      verdict: 'pending',
    },
    tx,
  );
  await audit.record(
    actorRef(actor),
    'intelligence.recommendation.create',
    { type: 'recommendation', id },
    'allowed',
    tx,
    {
      brandId: input.brandId,
      runId: input.agentRunId,
      toState: 'proposed',
    },
  );
  return id;
}

export const intelligenceService = {
  insights: {
    async list(actor: ResolvedActor, input: z.infer<typeof InsightList>, tx?: Tx) {
      const parsed = InsightList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(brand.id), {}, tx);
      const page = await insightsRepo.list(
        brand.id,
        { kind: parsed.kind, state: parsed.state },
        parsed.page,
        tx,
      );
      return { items: page.items.map(toInsightDto), nextCursor: page.nextCursor };
    },

    /** Module-internal: an insight written by the analyst (deterministic movements or the run's hypotheses). */
    async record(
      actor: ResolvedActor,
      input: {
        brandId: string;
        kind: InsightRow['kind'];
        statement: string;
        evidence: InsightRow['evidence'];
        strength: InsightRow['strength'];
        periodStart: Date;
        periodEnd: Date;
        agentRunId: string | null;
      },
      tx: Tx,
    ) {
      const id = newId('insight');
      await insightsRepo.create(
        {
          id,
          brandId: input.brandId,
          kind: input.kind,
          statement: input.statement,
          evidence: input.evidence,
          strength: input.strength,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          state: 'active',
          agentRunId: input.agentRunId,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'intelligence.insight.create',
        { type: 'insight', id },
        'allowed',
        tx,
        {
          brandId: input.brandId,
          runId: input.agentRunId,
        },
      );
      return { insightId: id };
    },
  },

  recommendations: {
    async list(actor: ResolvedActor, input: z.infer<typeof RecommendationList>, tx?: Tx) {
      const parsed = RecommendationList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(brand.id), {}, tx);
      const page = await recommendationsRepo.list(brand.id, parsed.state, parsed.page, tx);
      const learning = await learningRepo.listForRecommendations(
        brand.id,
        page.items.map((r) => r.id),
        tx,
      );
      const objective = await activeObjective(actor, brand.id, tx);
      return {
        items: page.items.map((r) =>
          toRecommendationDto(r, learning.find((l) => l.recommendationId === r.id) ?? null),
        ),
        nextCursor: page.nextCursor,
        /** Spec 16.1: without an objective the list is unranked and says so. */
        ranked: objective !== null,
        objective,
      };
    },

    async get(actor: ResolvedActor, input: z.infer<typeof RecommendationGet>, tx?: Tx) {
      const parsed = RecommendationGet.parse(input);
      const r = await recommendationsRepo.getById(parsed.recommendationId, tx);
      await policy.assert(actor, 'insight.read', recommendationResource(r), {}, tx);
      return toRecommendationDto(r, await learningRepo.findForRecommendation(r.brandId, r.id, tx));
    },

    /** Spec 12.4 recommendations.create: the run's proposal, with its hypothesis recorded as an association insight. */
    async createFromRun(
      actor: ResolvedActor,
      input: {
        brandId: string;
        runId: string;
        title: string;
        rationale: string;
        evidenceRefs: string[];
        suggestedAction: 'brief' | 'variant' | 'experiment' | 'playbook_entry';
      },
      tx: Tx,
    ) {
      const brand = await brandService.get(actor, input.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(brand.id), {}, tx);
      const run = await agentsService.runs.get(actor, { runId: input.runId }, tx); // NOT_FOUND for a foreign run
      if (run.brandId !== brand.id) throw new NotFoundError('AgentRun', input.runId);
      // Evidence refs that are this brand's insight ids are linked; anything else is kept as a reference only.
      const known = await insightsRepo.listByIds(
        brand.id,
        input.evidenceRefs.filter((r) => r.startsWith('ins_')),
        tx,
      );
      const other = input.evidenceRefs.filter((r) => !known.some((k) => k.id === r));
      const objective = await activeObjective(actor, brand.id, tx);
      const period = known[0] ? { start: known[0].periodStart, end: known[0].periodEnd } : null;
      const hypothesis = await intelligenceService.insights.record(
        actor,
        {
          brandId: brand.id,
          kind: 'association',
          statement: `Hypothesis: ${input.rationale}`.slice(0, 4000),
          evidence: [
            ...known.map((k) => ({ kind: 'insight', ref: k.id })),
            ...other.map((ref) => ({ kind: 'other', ref: ref.slice(0, 200) })),
          ],
          strength: 'observed',
          periodStart: (period?.start ?? run.createdAt) ? new Date(run.createdAt) : new Date(),
          periodEnd: period?.end ?? new Date(),
          agentRunId: run.id,
        },
        tx,
      );
      const recommendationId = await createRecommendationWithChain(
        actor,
        {
          brandId: brand.id,
          insightIds: [...known.map((k) => k.id), hypothesis.insightId],
          proposedAction: ACTION_FOR_SUGGESTION[input.suggestedAction],
          title: input.title,
          rationale: input.rationale,
          expectedBenefit: { metricKey: objective?.primaryMetricKey ?? 'unspecified', direction: 'up' },
          effort: 'medium',
          uncertainty: 'medium',
          agentRunId: run.id,
          contextRef: `agent_run:${run.id}`,
        },
        tx,
      );
      return { recommendationId };
    },

    /**
     * Spec 16.1 / 16.8: rank the brand's proposed recommendations toward its active objective with the ranker in
     * force (baseline unless the monthly comparison selected the learned one), plus the exploration share once
     * the brand has the volume. Refuses without an objective.
     */
    async rank(actor: ResolvedActor, input: { brandId: string }, tx: Tx) {
      const brand = await brandService.get(actor, input.brandId, tx);
      await policy.assert(actor, 'insight.manage', brandResource(brand.id), policyOptions(actor), tx);
      const objective = requireObjective(await activeObjective(actor, brand.id, tx));
      const proposed = await recommendationsRepo.listProposed(brand.id, tx);
      const history = await outcomeHistory(brand.id, tx);
      const cfg = currentRankingConfig();
      const ranker = await rankerFor(brand.id, tx);
      const items = proposed.map(rankable);
      let ordered =
        ranker === 'learned' ? rankLearned(items, objective, history) : rankBaseline(items, objective);
      let rankingPolicy: RankingPolicy = ranker === 'learned' ? 'learned' : 'baseline';
      const now = new Date();
      const volume = await publicationVolume(brand.id, new Date(now.getTime() - 30 * 86_400_000), now, tx);
      const explored = applyExploration(ordered, history, cfg, volume);
      if (ranker === 'exploration' || explored.some((r, i) => r.id !== ordered[i]?.id)) {
        ordered = explored;
        rankingPolicy = 'exploration';
      }
      for (const [i, item] of ordered.entries()) {
        const row = proposed.find((r) => r.id === item.id);
        if (row && (row.rank !== i + 1 || row.rankingPolicy !== rankingPolicy))
          await recommendationsRepo.update(row.id, row.version, { rank: i + 1, rankingPolicy }, tx);
      }
      await audit.record(
        actorRef(actor),
        'intelligence.recommendations.rank',
        { type: 'brand', id: brand.id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          count: ordered.length,
          reason: rankingPolicy,
        },
      );
      return { brandId: brand.id, rankingPolicy, order: ordered.map((r) => r.id), objective };
    },

    /**
     * Spec 16.4: accepting creates the downstream object with a back-reference (brief, copywriting run,
     * experiment draft, playbook proposal) in the same transaction, and the learning record moves to
     * "human decision: accepted". Only the offered action is accepted; a person decides.
     */
    async accept(actor: ResolvedActor, input: z.infer<typeof RecommendationAccept>, tx: Tx) {
      const parsed = RecommendationAccept.parse(input);
      const r = await recommendationsRepo.lock(parsed.recommendationId, tx);
      await policy.assert(actor, 'insight.manage', recommendationResource(r), {}, tx);
      if (actor.kind !== 'user')
        throw new PolicyDeniedError('agent_never', 'A person decides on a recommendation');
      if (r.state !== 'proposed')
        throw new ValidationFailedError([
          { path: 'recommendationId', issue: `recommendation is ${r.state}` },
        ]);
      if (!actionsFor(r).includes(parsed.action))
        throw new ValidationFailedError([{ path: 'action', issue: 'action_not_offered' }]);
      let downstream: { type: string; id: string | null };
      switch (parsed.action) {
        case 'create_brief': {
          if (!parsed.brief)
            throw new ValidationFailedError([{ path: 'brief', issue: 'required for create_brief' }]);
          const brief = await contentService.briefs.create(
            actor,
            { brandId: r.brandId, ...parsed.brief, constraints: [], recommendationId: r.id },
            tx,
          );
          downstream = { type: 'brief', id: brief.briefId };
          break;
        }
        case 'generate_variants': {
          if (!parsed.servicePrincipalId)
            throw new ValidationFailedError([
              { path: 'servicePrincipalId', issue: 'required for generate_variants' },
            ]);
          const run = await agentsService.runs.start(
            actor,
            {
              brandId: r.brandId,
              servicePrincipalId: parsed.servicePrincipalId,
              requestedAutonomy: 'create',
              taskKind: 'copywriting',
              brief: {
                recommendationId: r.id,
                objective: r.title,
                rationale: r.rationale,
                insightIds: r.insightIds,
              },
            },
            tx,
          );
          downstream = { type: 'agent_run', id: run.runId };
          break;
        }
        case 'prepare_test': {
          const design = ExperimentDesign.shape.design.safeParse(parsed.experimentDesign);
          if (!design.success)
            throw new ValidationFailedError(
              design.error.issues.map((i) => ({
                path: `experimentDesign.${i.path.join('.')}`,
                issue: i.message,
              })),
            );
          const created = await experiments.design(
            actor,
            { brandId: r.brandId, recommendationId: r.id, design: design.data },
            tx,
          );
          downstream = { type: 'experiment', id: created.experimentId };
          break;
        }
        case 'propose_playbook_update': {
          if (!parsed.playbook)
            throw new ValidationFailedError([
              { path: 'playbook', issue: 'required for propose_playbook_update' },
            ]);
          const proposed = await intelligenceService.playbook.propose(
            actor,
            {
              brandId: r.brandId,
              practice: parsed.playbook.practice,
              evidenceInsightIds: r.insightIds,
              strength: 'observed',
              reviewAfter: parsed.playbook.reviewAfter,
            },
            tx,
          );
          downstream = { type: 'playbook_entry', id: proposed.playbookEntryId };
          break;
        }
        case 'open_canvas':
          downstream = { type: 'canvas', id: null }; // the studio opens; nothing is created server-side
          break;
        case 'assign_response':
          throw new ValidationFailedError([
            { path: 'action', issue: 'inbox assignment arrives with the inbox (Release 2)' },
          ]);
      }
      await recommendationsRepo.update(
        r.id,
        parsed.expectedVersion,
        {
          state: 'accepted',
          decidedByUserId: actor.id,
          downstreamType: downstream.type,
          downstreamId: downstream.id,
        },
        tx,
      );
      const learning = await learningFor(r, tx);
      await learningRepo.update(
        learning.id,
        learning.version,
        { humanDecision: 'accepted', action: parsed.action },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'intelligence.recommendation.accept',
        { type: 'recommendation', id: r.id },
        'allowed',
        tx,
        {
          brandId: r.brandId,
          fromState: r.state,
          toState: 'accepted',
          reason: parsed.action,
          downstreamType: downstream.type,
          downstreamId: downstream.id,
        },
      );
      return {
        recommendationId: r.id,
        state: 'accepted' as const,
        action: parsed.action,
        downstreamType: downstream.type,
        downstreamId: downstream.id,
        version: parsed.expectedVersion + 1,
      };
    },

    /** Spec 16.4 / 16.8: dismissal stores its reason; it explains a preference and is never performance evidence. */
    async dismiss(actor: ResolvedActor, input: z.infer<typeof RecommendationDismiss>, tx: Tx) {
      const parsed = RecommendationDismiss.parse(input);
      const r = await recommendationsRepo.lock(parsed.recommendationId, tx);
      await policy.assert(actor, 'insight.manage', recommendationResource(r), {}, tx);
      if (actor.kind !== 'user')
        throw new PolicyDeniedError('agent_never', 'A person decides on a recommendation');
      if (r.state !== 'proposed')
        throw new ValidationFailedError([
          { path: 'recommendationId', issue: `recommendation is ${r.state}` },
        ]);
      await recommendationsRepo.update(
        r.id,
        parsed.expectedVersion,
        { state: 'dismissed', decidedByUserId: actor.id, dismissalReason: parsed.reason },
        tx,
      );
      const learning = await learningFor(r, tx);
      await learningRepo.update(learning.id, learning.version, { humanDecision: 'rejected' }, tx);
      await audit.record(
        actorRef(actor),
        'intelligence.recommendation.dismiss',
        { type: 'recommendation', id: r.id },
        'allowed',
        tx,
        {
          brandId: r.brandId,
          fromState: r.state,
          toState: 'dismissed',
          reason: parsed.reason,
        },
      );
      return { recommendationId: r.id, state: 'dismissed' as const, version: parsed.expectedVersion + 1 };
    },
  },

  playbook: {
    async list(actor: ResolvedActor, input: z.infer<typeof PlaybookList>, tx?: Tx) {
      const parsed = PlaybookList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(brand.id), {}, tx);
      const page = await playbookRepo.list(brand.id, parsed.state, parsed.page, tx);
      return { items: page.items.map(toPlaybookDto), nextCursor: page.nextCursor };
    },

    /** A proposal (by a person or an accepted recommendation) with its evidence, strength and review date. */
    async propose(actor: ResolvedActor, input: z.infer<typeof PlaybookPropose>, tx: Tx) {
      const parsed = PlaybookPropose.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'insight.manage', brandResource(brand.id), {}, tx);
      const evidence = await insightsRepo.listByIds(brand.id, parsed.evidenceInsightIds, tx);
      if (evidence.length !== new Set(parsed.evidenceInsightIds).size)
        throw new ValidationFailedError([{ path: 'evidenceInsightIds', issue: 'insight_not_in_brand' }]);
      const reviewAfter = new Date(parsed.reviewAfter);
      if (reviewAfter.getTime() <= Date.now())
        throw new ValidationFailedError([{ path: 'reviewAfter', issue: 'must be in the future' }]);
      const id = newId('playbookEntry');
      await playbookRepo.create(
        {
          id,
          brandId: brand.id,
          practice: parsed.practice,
          evidenceIds: parsed.evidenceInsightIds,
          strength: parsed.strength,
          approvedByUserId: null,
          reviewAfter,
          state: 'proposed',
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'intelligence.playbook.propose',
        { type: 'playbook_entry', id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          toState: 'proposed',
        },
      );
      return { playbookEntryId: id, state: 'proposed' as const, version: 0 };
    },

    /** Spec 16.8: only a person with playbook.approve; standards are never rewritten automatically. */
    async approve(actor: ResolvedActor, input: z.infer<typeof PlaybookApprove>, tx: Tx) {
      const parsed = PlaybookApprove.parse(input);
      const p = await playbookRepo.getById(parsed.playbookEntryId, tx);
      await policy.assert(
        actor,
        'playbook.approve',
        { type: 'playbook_entry', tenantId: p.tenantId, brandId: p.brandId, id: p.id, state: p.state },
        {},
        tx,
      );
      if (actor.kind !== 'user')
        throw new PolicyDeniedError('agent_never', 'A person approves a playbook entry');
      if (p.state !== 'proposed')
        throw new ValidationFailedError([{ path: 'playbookEntryId', issue: `entry is ${p.state}` }]);
      await playbookRepo.update(
        p.id,
        parsed.expectedVersion,
        { state: 'approved', approvedByUserId: actor.id },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'intelligence.playbook.approve',
        { type: 'playbook_entry', id: p.id },
        'allowed',
        tx,
        {
          brandId: p.brandId,
          fromState: p.state,
          toState: 'approved',
        },
      );
      return { playbookEntryId: p.id, state: 'approved' as const, version: parsed.expectedVersion + 1 };
    },
  },

  voice: {
    async clusters(actor: ResolvedActor, input: z.infer<typeof VoiceClustersList>, tx?: Tx) {
      const parsed = VoiceClustersList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(brand.id), {}, tx);
      const rows = await clustersRepo.listForBrand(brand.id, parsed.kind, parsed.limit, tx);
      return { items: rows.map(toClusterDto) };
    },

    /**
     * Spec 16.5: the classification alone (a model call behind the routing policy), for ingestion to run before its
     * transaction opens and pass to ingest; runs in the caller's tenant context.
     */
    async classify(input: { text: string }): Promise<MessageClassificationValue> {
      const { tenantId } = requireTenant();
      return classifyComment(tenantId, input.text);
    },

    /**
     * Spec 16.5: the comment sink. Classifies (unless classified upstream), embeds with the tenant salt and joins
     * the nearest cluster of the brand and kind or opens a new one. Spam and other are never clustered. Runs in the
     * caller's tenant context (the ingestion workflow's); the brand scope of the repository is the isolation.
     */
    async ingest(input: z.infer<typeof VoiceCommentInput>, tx: Tx) {
      const parsed = VoiceCommentInput.parse(input);
      const { tenantId } = requireTenant();
      const classification = parsed.classification ?? (await classifyComment(tenantId, parsed.text));
      if (classification === 'spam' || classification === 'other')
        return { messageId: parsed.messageId, classification, clusterId: null };
      const vector = await embedText(tenantId, parsed.text);
      const candidates = await clustersRepo.lockForBrand(parsed.brandId, classification, tx);
      const seenAt = new Date(parsed.remoteCreatedAt);
      const match = nearestCluster(vector, candidates);
      if (match) {
        const c = match.cluster;
        await clustersRepo.update(
          c.id,
          c.version,
          {
            size: c.size + 1,
            centroid: updatedCentroid(c.centroid as number[], c.size, vector),
            sampleMessageRefs: c.sampleMessageRefs.includes(parsed.messageId)
              ? c.sampleMessageRefs
              : [...c.sampleMessageRefs, parsed.messageId].slice(-5),
            firstSeen: seenAt < c.firstSeen ? seenAt : c.firstSeen,
            lastSeen: seenAt > c.lastSeen ? seenAt : c.lastSeen,
          },
          tx,
        );
        return { messageId: parsed.messageId, classification, clusterId: c.id, similarity: match.similarity };
      }
      const id = newId('customerVoiceCluster');
      await clustersRepo.create(
        {
          id,
          brandId: parsed.brandId,
          label: labelFor(parsed.text),
          kind: classification,
          size: 1,
          sampleMessageRefs: [parsed.messageId],
          centroid: vector,
          linkedRecommendationIds: [],
          firstSeen: seenAt,
          lastSeen: seenAt,
        },
        tx,
      );
      return { messageId: parsed.messageId, classification, clusterId: id, similarity: 1 };
    },
  },

  anomalies: {
    async list(actor: ResolvedActor, input: z.infer<typeof AnomalyList>, tx?: Tx) {
      const parsed = AnomalyList.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(brand.id), {}, tx);
      const page = await anomaliesRepo.list(brand.id, parsed.state, parsed.page, tx);
      return {
        items: page.items.map((a) => ({
          id: a.id,
          brandId: a.brandId,
          signal: a.signal,
          baseline: a.baseline,
          observed: a.observed,
          severity: a.severity,
          detectedAt: a.detectedAt.toISOString(),
          state: a.state,
          version: a.version,
        })),
        nextCursor: page.nextCursor,
      };
    },
  },

  analyst: {
    /** Spec 16.3 on demand: intelligence.analysis_due → brandAnalystWorkflowV1 (the weekly schedule uses the same route). */
    async run(actor: ResolvedActor, input: z.infer<typeof AnalystRun>, tx: Tx) {
      const parsed = AnalystRun.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'insight.manage', brandResource(brand.id), {}, tx);
      const { tenantId } = requireTenant();
      if (!(await featureFlag.isEnabled('intelligence.brand_analyst', tenantId, tx)))
        throw new PolicyDeniedError('feature_flag_off', 'The brand analyst is not enabled for this company');
      const periodEnd = new Date();
      const periodStart = new Date(periodEnd.getTime() - parsed.periodDays * 86_400_000);
      const workflowId = `brand-analyst:${brand.id}:${periodEnd.toISOString().slice(0, 10)}`;
      await outbox.add(
        'intelligence.analysis_due',
        { type: 'brand', id: brand.id, version: 0 },
        {
          brandId: brand.id,
          servicePrincipalId: parsed.servicePrincipalId,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          workflowId,
          requestedByKind: actor.kind,
          requestedById: actor.id,
        },
        tx,
        { brandId: brand.id },
      );
      await audit.record(
        actorRef(actor),
        'intelligence.analyst.run',
        { type: 'brand', id: brand.id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          reason: 'on_demand',
        },
      );
      return {
        brandId: brand.id,
        workflowId,
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      };
    },
  },

  learning: {
    /**
     * Spec 16.8: the executed revision, observed outcome and verdict of a recommendation's chain come from the
     * experiment it produced (the experiments module reports milestones through a hook). An experimentally
     * supported finding is recorded as its own insight, visibly separate from observations (spec 16.9).
     */
    async onExperimentMilestone(
      milestone: {
        kind: 'pre_registered' | 'started' | 'stopped' | 'analysed';
        brandId: string;
        experimentId: string;
        recommendationId: string | null;
        preRegistrationHash: string | null;
        mode?: string;
        executedRevisionId?: string | null;
        resultId?: string;
        verdict?: 'supported' | 'not_supported' | 'inconclusive';
        verdictReason?: string;
      },
      tx: Tx,
    ) {
      if (!milestone.recommendationId) return;
      const learning = await learningRepo.findForRecommendation(
        milestone.brandId,
        milestone.recommendationId,
        tx,
      );
      if (!learning) return;
      const r = await recommendationsRepo.getById(milestone.recommendationId, tx);
      const actor = requireTenant().actor;
      if (milestone.kind === 'pre_registered') {
        await learningRepo.update(
          learning.id,
          learning.version,
          {
            evidenceRef: `${learning.evidenceRef};design:${milestone.preRegistrationHash ?? ''}`.slice(
              0,
              200,
            ),
          },
          tx,
        );
      } else if (milestone.kind === 'started') {
        await learningRepo.update(
          learning.id,
          learning.version,
          { executedRevisionId: milestone.executedRevisionId ?? null },
          tx,
        );
        if (r.state === 'accepted')
          await recommendationsRepo.update(r.id, r.version, { state: 'executed' }, tx);
      } else if (milestone.kind === 'analysed' && milestone.verdict && milestone.resultId) {
        await learningRepo.update(
          learning.id,
          learning.version,
          {
            observedOutcomeRef: `experiment_result:${milestone.resultId}`.slice(0, 200),
            verdict: milestone.verdict,
          },
          tx,
        );
        if (r.state === 'accepted')
          await recommendationsRepo.update(r.id, r.version, { state: 'executed' }, tx);
        const supported = milestone.verdict === 'supported';
        const causal = milestone.mode === 'randomised';
        await insightsRepo.create(
          {
            id: newId('insight'),
            brandId: r.brandId,
            kind: 'experimental_finding',
            statement:
              `${supported ? 'Supported' : milestone.verdict === 'inconclusive' ? 'Inconclusive' : 'Not supported'}${causal ? '' : ' (directional; not causal)'}: ${r.title} — ${milestone.verdictReason ?? ''}`.slice(
                0,
                4000,
              ),
            evidence: [
              { kind: 'experiment_result', ref: milestone.resultId },
              { kind: 'recommendation', ref: r.id },
              ...(milestone.preRegistrationHash
                ? [{ kind: 'pre_registration', ref: milestone.preRegistrationHash }]
                : []),
            ],
            strength: causal ? 'experimentally_supported' : 'directional',
            periodStart: r.createdAt,
            periodEnd: new Date(),
            state: 'active',
            agentRunId: r.agentRunId,
          },
          tx,
        );
        await audit.record(
          actor,
          'intelligence.learning.verdict',
          { type: 'learning_record', id: learning.id },
          'allowed',
          tx,
          {
            brandId: r.brandId,
            reason: milestone.verdict,
            experimentId: milestone.experimentId,
          },
        );
      }
    },

    /**
     * Spec 16.8 baseline comparison: re-rank the recommendations decided in the period with each policy and score
     * both orderings on the outcomes observed since (unseen when they were ranked). The learned ranker is used only
     * when it beats the baseline by the margin; the comparison is stored as an insight the ranker reads back.
     */
    async compareRankingBaseline(
      actor: ResolvedActor,
      input: { brandId: string; periodStart: Date; periodEnd: Date },
      tx: Tx,
    ) {
      const brand = await brandService.get(actor, input.brandId, tx);
      await policy.assert(actor, 'insight.manage', brandResource(brand.id), policyOptions(actor), tx);
      const objective = await activeObjective(actor, brand.id, tx);
      const cfg = currentRankingConfig();
      const decided = await recommendationsRepo.listDecidedBetween(
        brand.id,
        input.periodStart,
        input.periodEnd,
        tx,
      );
      const records = await learningRepo.listForRecommendations(
        brand.id,
        decided.map((r) => r.id),
        tx,
      );
      const outcomes = new Map<string, number>();
      for (const l of records)
        if (l.verdict !== 'pending' && l.humanDecision !== 'rejected')
          outcomes.set(l.recommendationId, VERDICT_SCORE[l.verdict]);
      // Only loops closed on recommendations decided before the period: the period's own verdicts are what is scored.
      const history = await outcomeHistory(brand.id, tx, input.periodStart);
      const comparison = objective
        ? compareRankings(decided.map(rankable), objective, history, outcomes, cfg.baselineMargin)
        : {
            learnedScore: null,
            baselineScore: null,
            margin: cfg.baselineMargin,
            beaten: false,
            selected: 'baseline' as const,
          };
      // The previous comparison is superseded; the newest active one is what rankerFor reads.
      for (const prior of (await insightsRepo.listActive(brand.id, ['association'], tx)).filter((i) =>
        i.evidence.some((e) => e.kind === BASELINE_COMPARISON_EVIDENCE),
      ))
        await insightsRepo.update(prior.id, prior.version, { state: 'superseded' }, tx);
      const id = newId('insight');
      const fmt = (n: number | null) => (n === null ? 'n/a' : n.toFixed(3));
      await insightsRepo.create(
        {
          id,
          brandId: brand.id,
          kind: 'association',
          statement: `Ranking baseline comparison (${outcomes.size} outcome${outcomes.size === 1 ? '' : 's'}): learned ${fmt(comparison.learnedScore)} vs baseline ${fmt(comparison.baselineScore)}, margin ${comparison.margin}; ${comparison.beaten ? 'learned ranking beats the baseline and is selected' : 'baseline retained (learned ranking did not beat it)'}${objective ? '' : '; no active objective'}`,
          evidence: [
            {
              kind: BASELINE_COMPARISON_EVIDENCE,
              ref: comparison.selected,
              note: JSON.stringify({
                ...comparison,
                evaluated: outcomes.size,
                periodStart: input.periodStart.toISOString(),
                periodEnd: input.periodEnd.toISOString(),
              }),
            },
            ...decided.map((r) => ({ kind: 'recommendation', ref: r.id })),
          ],
          strength: 'observed',
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          state: 'active',
          agentRunId: null,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'intelligence.ranking.baseline_comparison',
        { type: 'insight', id },
        'allowed',
        tx,
        {
          brandId: brand.id,
          reason: comparison.selected,
          count: outcomes.size,
        },
      );
      return { brandId: brand.id, evaluated: outcomes.size, ...comparison, insightId: id };
    },
  },

  workspace: {
    /** Spec 16.9: the five views with their coverage statements and freshness (the UI arrives later). */
    async get(actor: ResolvedActor, input: z.infer<typeof WorkspaceGet>, tx?: Tx) {
      const parsed = WorkspaceGet.parse(input);
      const brand = await brandService.get(actor, parsed.brandId, tx);
      await policy.assert(actor, 'insight.read', brandResource(brand.id), {}, tx);
      const now = new Date();
      const objective = await activeObjective(actor, brand.id, tx);
      const changes = await insightsRepo.listActive(brand.id, ['change', 'anomaly'], tx);
      const associations = (await insightsRepo.listActive(brand.id, ['association'], tx)).filter(
        (i) => !i.evidence.some((e) => e.kind === BASELINE_COMPARISON_EVIDENCE),
      );
      const findings = await insightsRepo.listActive(brand.id, ['experimental_finding'], tx);
      const proposed = await recommendationsRepo.listProposed(brand.id, tx);
      const learning = await learningRepo.listForRecommendations(
        brand.id,
        proposed.map((r) => r.id),
        tx,
      );
      const xs = await experimentsForBrand(brand.id, tx);
      const playbook = await playbookRepo.listApproved(brand.id, tx);
      const ranker = await rankerFor(brand.id, tx);
      const changeAsOf = newest(changes.map((i) => i.periodEnd));
      const metricKeys = [
        ...new Set(
          changes.flatMap((i) => i.evidence.filter((e) => e.kind === 'metric_key').map((e) => e.ref)),
        ),
      ];
      const group = (state: string) =>
        state === 'designed' || state === 'pre_registered'
          ? 'planned'
          : state === 'running'
            ? 'running'
            : 'completed';
      return {
        brandId: brand.id,
        objective,
        whatChanged: {
          items: changes.map(toInsightDto),
          coverage: {
            sources: metricKeys,
            competitors: [],
            languages: [],
            periodStart: (newest(changes.map((i) => i.periodStart)) ?? now).toISOString(),
            periodEnd: (changeAsOf ?? now).toISOString(),
            statement: changes.length
              ? `Metric movements for ${metricKeys.length} metric key(s); missing snapshots are reported as gaps, never as zero`
              : 'No analysis has run for this brand yet',
          },
          freshness: freshnessOf(changeAsOf, now),
        },
        whatWeLearned: {
          observations: associations.map(toInsightDto),
          experimentallySupported: findings
            .filter((f) => f.strength === 'experimentally_supported')
            .map(toInsightDto),
          directional: findings.filter((f) => f.strength !== 'experimentally_supported').map(toInsightDto),
          statement:
            'Observations and hypotheses are not findings; only experimentally supported entries can support causal claims',
          freshness: freshnessOf(newest([...associations, ...findings].map((i) => i.updatedAt)), now),
        },
        whatToDoNext: {
          items: proposed.map((r) =>
            toRecommendationDto(r, learning.find((l) => l.recommendationId === r.id) ?? null),
          ),
          ranked: objective !== null && proposed.some((r) => r.rank > 0),
          rankingPolicy: ranker,
          statement: objective
            ? `Ranked toward "${objective.primaryMetricKey}" with the ${ranker} ranker; effort and uncertainty shown per action`
            : 'No active objective: recommendations are listed unranked until the brand objective is set (spec 16.1)',
          freshness: freshnessOf(newest(proposed.map((r) => r.updatedAt)), now),
        },
        experiments: {
          planned: xs.filter((x) => group(x.state) === 'planned'),
          running: xs.filter((x) => group(x.state) === 'running'),
          completed: xs.filter(
            (x) => group(x.state) === 'completed' && x.latestResult?.verdict !== 'inconclusive',
          ),
          inconclusive: xs.filter(
            (x) => group(x.state) === 'completed' && x.latestResult?.verdict === 'inconclusive',
          ),
          statement:
            'Structured comparisons are directional, not causal; randomised experiments can support causal claims when design and execution are sound',
          freshness: freshnessOf(
            newest(
              xs.map((x) =>
                x.latestResult
                  ? new Date(x.latestResult.computedAt)
                  : x.startedAt
                    ? new Date(x.startedAt)
                    : null,
              ),
            ),
            now,
          ),
        },
        brandPlaybook: {
          items: playbook.map(toPlaybookDto),
          dueForReview: playbook.filter((p) => p.reviewAfter <= now).map((p) => p.id),
          statement:
            'Approved practices only, each with its evidence, strength and reconsider-by date; standards are never rewritten automatically',
          freshness: freshnessOf(newest(playbook.map((p) => p.updatedAt)), now),
        },
      };
    },
  },
};
