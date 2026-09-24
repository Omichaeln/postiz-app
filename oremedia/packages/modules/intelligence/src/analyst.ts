import type {
  AnalystSweepRuntimeV1,
  BaselineComparisonRuntimeV1,
  BrandAnalystRuntimeV1,
  BrandAnalystWorkflowInputV1,
  PrepareAnalysisResultV1,
} from '@oremedia/contracts/intelligence';
import type { MetricValueV1 } from '@oremedia/contracts/measurement';
import { ConflictError, OremediaError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { withTransaction, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { agentRunMachine } from '@oremedia/domain/state-machines/agent-run';
import { resolveTenantContext } from '@oremedia/module-access';
import { agentsService } from '@oremedia/module-agents';
import { brandService } from '@oremedia/module-brand';
import { featureFlag } from '@oremedia/module-operations';
import { logger } from '@oremedia/observability';
import { analystTargets, metrics, MetricsSourceUnregisteredError } from './hooks';
import { AnomalyRepository, InsightRepository } from './repositories';
import { intelligenceService } from './service';

const anomaliesRepo = new AnomalyRepository();
const insightsRepo = new InsightRepository();
const TERMINAL: ReadonlySet<string> = new Set(agentRunMachine.terminal);

/** The first evidence item of a deterministic movement insight names its metric key. */
const MOVEMENT_EVIDENCE = 'metric_key';
/** Recorded on the movements by the transaction that starts the run reviewing them (the retry's marker). */
export const ANALYST_RUN_EVIDENCE = 'analyst_run';

type InsightRow = Awaited<ReturnType<InsightRepository['listForPeriod']>>[number];

/** The analyst's own movement insights of exactly this period (never a run's insights), oldest first. */
async function movementInsightsFor(brandId: string, periodStart: Date, periodEnd: Date, tx: Tx) {
  return (
    await insightsRepo.listForPeriod(brandId, ['change', 'anomaly'], periodStart, periodEnd, tx)
  ).filter((i) => i.agentRunId === null && i.evidence[0]?.kind === MOVEMENT_EVIDENCE);
}
const analystRunOf = (rows: readonly InsightRow[]): string | null =>
  rows.flatMap((i) => i.evidence).find((e) => e.kind === ANALYST_RUN_EVIDENCE)?.ref ?? null;

/** Movements at or beyond this share of the previous period are anomalies worth a row (spec 16.3 "anomalies"). */
export const ANOMALY_THRESHOLD = 0.5;
export const CHANGE_THRESHOLD = 0.1;

/** The run's service principal as it is now, through the same resolver as the API (spec 5.2). */
async function principalFor(input: BrandAnalystWorkflowInputV1): Promise<ResolvedActor> {
  const resolved = await resolveTenantContext(
    {
      kind: 'api_client',
      apiClientId: `analyst:${input.correlationId}`,
      servicePrincipalId: input.servicePrincipalId,
      tenantId: input.tenantId,
      scopes: [],
    },
    input.tenantId,
    input.correlationId,
  );
  if (resolved.actor.kind !== 'service_principal')
    throw new PolicyDeniedError('principal_kind', 'The analyst acts as a service principal');
  return resolved.actor;
}

export interface MetricMovement {
  metricKey: string;
  current: number | null;
  previous: number | null;
  change: number | null;
  completeness: 'complete' | 'partial' | 'unavailable';
  freshest: string | null;
  snapshotIds: string[];
}

const sum = (values: readonly MetricValueV1[]): number | null => {
  const present = values.filter((v) => v.value !== null);
  return present.length ? present.reduce((s, v) => s + (v.value as number), 0) : null;
};

/**
 * Spec 16.3 "what changed", deterministically: period totals against the previous period, per metric key, with
 * completeness and freshness carried along. Missing is never zero: a key without data reports `unavailable`.
 */
export function movementsOf(
  metricKeys: readonly string[],
  current: readonly MetricValueV1[],
  previous: readonly MetricValueV1[],
): MetricMovement[] {
  return metricKeys.map((metricKey) => {
    const now = current.filter((v) => v.metricKey === metricKey);
    const before = previous.filter((v) => v.metricKey === metricKey);
    const cur = sum(now);
    const prev = sum(before);
    const completeness: MetricMovement['completeness'] =
      now.length === 0 || now.every((v) => v.completeness === 'unavailable')
        ? 'unavailable'
        : now.every((v) => v.completeness === 'complete')
          ? 'complete'
          : 'partial';
    const freshest = now.reduce<string | null>(
      (m, v) => (!m || v.freshness.fetchedAt > m ? v.freshness.fetchedAt : m),
      null,
    );
    const change = cur !== null && prev !== null && prev !== 0 ? (cur - prev) / Math.abs(prev) : null;
    return {
      metricKey,
      current: cur,
      previous: prev,
      change,
      completeness,
      freshest,
      snapshotIds: now.map((v) => v.snapshotId).slice(0, 20),
    };
  });
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

/** One sentence per movement, with the caveats the data carries (spec 16.3: never compare across a gap silently). */
export function statementFor(m: MetricMovement): string {
  if (m.completeness === 'unavailable')
    return `${m.metricKey}: no snapshots for the period (data gap; missing is not zero)`;
  const caveat = m.completeness === 'partial' ? '; partial coverage, not a trend' : '';
  const fresh = m.freshest ? `; fetched ${m.freshest}` : '';
  if (m.change === null)
    return `${m.metricKey}: ${m.current ?? 'n/a'} this period, no comparable previous period${caveat}${fresh}`;
  return `${m.metricKey}: ${m.current} vs ${m.previous} previous period (${pct(m.change)})${caveat}${fresh}`;
}

export interface IntelligenceRuntimeOptions {
  now?: () => Date;
}

/**
 * Spec 16.3 activities behind brandAnalystWorkflowV1 (the activity host establishes tenant context as the
 * analyst's service principal): the deterministic movements are written first, then the performance-review run
 * starts through agentsService.runs.start like any run (the model calls recommendations.create; the run's
 * insights and recommendations are rows the moment the tool commits), then the outcome is ranked toward the
 * brand objective. The sweep and the monthly baseline comparison share the target listing.
 */
export function createIntelligenceRuntime(opts: IntelligenceRuntimeOptions = {}): {
  analyst: BrandAnalystRuntimeV1;
  sweep: AnalystSweepRuntimeV1;
  baseline: BaselineComparisonRuntimeV1;
} {
  const now = opts.now ?? (() => new Date());
  const log = () => logger().child('brand-analyst');

  const analyst: BrandAnalystRuntimeV1 = {
    async prepareAnalysis(input): Promise<PrepareAnalysisResultV1> {
      const actor = await principalFor(input);
      const periodStart = new Date(input.periodStart);
      const periodEnd = new Date(input.periodEnd);
      const emptyCoverage = {
        sources: [] as string[],
        competitors: [] as string[],
        languages: [] as string[],
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      };
      const skip = (reason: string): PrepareAnalysisResultV1 => {
        log().info({ tenantId: input.tenantId, brandId: input.brandId, status: reason }, 'analysis skipped');
        return { runId: null, skippedReason: reason, changeInsightIds: [], coverage: emptyCoverage };
      };
      if (!(await featureFlag.isEnabled('intelligence.brand_analyst', input.tenantId)))
        return skip('flag_off');
      const objectives = await brandService.objectives.list(actor, {
        brandId: input.brandId,
        activeOnly: true,
        page: { limit: 1 },
      });
      const objective = objectives.items[0];
      if (!objective) return skip('no_active_objective'); // spec 16.1: objectives before recommendations
      const metricKeys = [objective.primaryMetricKey, ...objective.guardrailMetricKeys];
      const previousStart = new Date(periodStart.getTime() - (periodEnd.getTime() - periodStart.getTime()));
      let current: MetricValueV1[];
      let previous: MetricValueV1[];
      let coverage = emptyCoverage;
      try {
        const query = { brandId: input.brandId, metricKeys, channelConnectionIds: [] };
        const cur = await metrics.query(actor, {
          ...query,
          windowStart: periodStart.toISOString(),
          windowEnd: periodEnd.toISOString(),
        });
        const prev = await metrics.query(actor, {
          ...query,
          windowStart: previousStart.toISOString(),
          windowEnd: periodStart.toISOString(),
        });
        current = cur.values;
        previous = prev.values;
        coverage = { ...emptyCoverage, sources: cur.coverage.metricsWithData };
      } catch (err) {
        if (err instanceof MetricsSourceUnregisteredError) return skip('metrics_source_not_registered');
        throw err;
      }
      const movements = movementsOf(metricKeys, current, previous);
      // prepareAnalysis is a retried activity: the movements of (brand, period) are written once and the run that
      // reviews them is recorded on them in the transaction that starts it, so a retry reuses both.
      const written = await withTransaction(async (tx) => {
        const existing = await movementInsightsFor(input.brandId, periodStart, periodEnd, tx);
        if (existing.length) return existing;
        for (const m of movements) {
          await intelligenceService.insights.record(
            actor,
            {
              brandId: input.brandId,
              kind: m.change !== null && Math.abs(m.change) >= ANOMALY_THRESHOLD ? 'anomaly' : 'change',
              statement: statementFor(m),
              evidence: [
                { kind: MOVEMENT_EVIDENCE, ref: m.metricKey, note: `completeness=${m.completeness}` },
                ...m.snapshotIds.map((ref) => ({ kind: 'metric_snapshot', ref })),
              ],
              strength: 'observed',
              periodStart,
              periodEnd,
              agentRunId: null,
            },
            tx,
          );
          if (
            m.change !== null &&
            Math.abs(m.change) >= ANOMALY_THRESHOLD &&
            m.previous !== null &&
            m.current !== null
          )
            await anomaliesRepo.create(
              {
                id: newId('anomaly'),
                brandId: input.brandId,
                signal: m.metricKey.slice(0, 120),
                baseline: m.previous,
                observed: m.current,
                severity: Math.abs(m.change) >= 1 ? 'high' : Math.abs(m.change) >= 0.75 ? 'medium' : 'low',
                detectedAt: now(),
                state: 'open',
              },
              tx,
            );
        }
        return movementInsightsFor(input.brandId, periodStart, periodEnd, tx);
      });
      // In the order of the objective's metric keys (ids of one millisecond do not sort by creation).
      const position = (i: InsightRow) => metricKeys.indexOf(i.evidence[0]?.ref ?? '');
      written.sort((a, b) => position(a) - position(b));
      const changeInsightIds = written.map((i) => i.id);
      const recordedRun = analystRunOf(written);
      if (recordedRun) return { runId: recordedRun, skippedReason: null, changeInsightIds, coverage };
      // The run: the performance-review skill over the movements (as labelled, untrusted evidence), the
      // experiments and the playbook it reads through its tools.
      let runId: string | null = null;
      try {
        runId = await withTransaction(async (tx) => {
          // Re-read under the transaction: an attempt that raced this one may have started the run meanwhile.
          const byId = new Map(
            (await insightsRepo.listByIds(input.brandId, changeInsightIds, tx)).map((i) => [i.id, i]),
          );
          const current = changeInsightIds.flatMap((id) => byId.get(id) ?? []);
          const raced = analystRunOf(current);
          if (raced) return raced;
          const started = await agentsService.runs.start(
            actor,
            {
              brandId: input.brandId,
              servicePrincipalId: input.servicePrincipalId,
              requestedAutonomy: 'assist',
              taskKind: 'performance_review',
              brief: {
                period: {
                  from: periodStart.toISOString().slice(0, 10),
                  to: periodEnd.toISOString().slice(0, 10),
                },
                metricKeys,
                experimentIds: [],
                evidence: current.map((i) => ({
                  id: i.id,
                  sourceKind: 'other',
                  ref: `insight:${i.id}`,
                  text: i.statement,
                })),
              },
            },
            tx,
            { autonomyMode: actor.kind === 'service_principal' ? actor.maxAutonomy : undefined },
          );
          // Versioned updates: a racing attempt that started its own run conflicts here and rolls it back.
          for (const i of current)
            await insightsRepo.update(
              i.id,
              i.version,
              { evidence: [...i.evidence, { kind: ANALYST_RUN_EVIDENCE, ref: started.runId }] },
              tx,
            );
          return started.runId;
        });
      } catch (err) {
        if (!(err instanceof OremediaError) || err instanceof ConflictError) throw err;
        // A paused brand (kill switch), an exhausted entitlement or a revoked principal: the movements stand,
        // the review does not run this week. Reported, never retried into a loop.
        return {
          runId: null,
          skippedReason: `run_not_started:${err.code.toLowerCase()}`,
          changeInsightIds,
          coverage,
        };
      }
      return { runId, skippedReason: null, changeInsightIds, coverage };
    },

    async readAnalystRun(input) {
      const actor = await principalFor(input);
      const run = await agentsService.runs.get(actor, { runId: input.runId });
      return { state: run.state, terminal: TERMINAL.has(run.state) };
    },

    async recordAnalystOutcome(input) {
      const actor = await principalFor(input);
      return withTransaction(async (tx) => {
        const recommendations = await intelligenceService.recommendations.list(
          actor,
          { brandId: input.brandId, state: 'proposed', page: { limit: 200 } },
          tx,
        );
        const fromRun = input.runId ? recommendations.items.filter((r) => r.agentRunId === input.runId) : [];
        const insights = input.runId
          ? (
              await intelligenceService.insights.list(
                actor,
                { brandId: input.brandId, state: 'active', page: { limit: 200 } },
                tx,
              )
            ).items.filter((i) => i.agentRunId === input.runId)
          : [];
        let rankingPolicy: 'baseline' | 'learned' | 'exploration' = 'baseline';
        if (recommendations.items.length) {
          const ranked = await intelligenceService.recommendations.rank(
            actor,
            { brandId: input.brandId },
            tx,
          );
          rankingPolicy = ranked.rankingPolicy;
        }
        log().info(
          {
            tenantId: input.tenantId,
            brandId: input.brandId,
            runId: input.runId ?? undefined,
            status: input.runState,
          },
          'analysis recorded',
        );
        return {
          insights: insights.length + input.changeInsightIds.length,
          recommendations: fromRun.length,
          rankingPolicy,
        };
      });
    },
  };

  const sweep: AnalystSweepRuntimeV1 = {
    listAnalystTargets: (input) => analystTargets(input.correlationId),
  };

  const baseline: BaselineComparisonRuntimeV1 = {
    listBaselineTargets: (input) => analystTargets(input.correlationId),
    async compareRankingBaseline(input) {
      const actor = await principalFor({
        ...input,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        servicePrincipalId: input.actor.id,
      });
      const result = await withTransaction((tx: Tx) =>
        intelligenceService.learning.compareRankingBaseline(
          actor,
          {
            brandId: input.brandId,
            periodStart: new Date(input.periodStart),
            periodEnd: new Date(input.periodEnd),
          },
          tx,
        ),
      );
      return {
        brandId: result.brandId,
        evaluated: result.evaluated,
        learnedScore: result.learnedScore,
        baselineScore: result.baselineScore,
        margin: result.margin,
        beaten: result.beaten,
        selected: result.selected,
        insightId: result.insightId,
      };
    },
  };

  return { analyst, sweep, baseline };
}
