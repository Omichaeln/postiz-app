import type { RankingPolicy } from '@oremedia/contracts/intelligence';

/** What the rankers see of a recommendation: never content, only the declared benefit, effort and uncertainty. */
export interface Rankable {
  id: string;
  proposedAction: string;
  expectedBenefit: { metricKey: string; direction: 'up' | 'down'; magnitude?: string };
  effort: 'low' | 'medium' | 'high';
  uncertainty: 'low' | 'medium' | 'high';
}
export interface RankingObjective {
  primaryMetricKey: string;
  guardrailMetricKeys: readonly string[];
}
/** One closed loop of the brand (spec 16.8): what was proposed and how it turned out; the learned ranker's input. */
export interface OutcomeHistory {
  action: string;
  metricKey: string;
  verdict: 'supported' | 'not_supported' | 'inconclusive';
}
export interface RankingConfig {
  /** The ranker in force: a setting, or `auto` = whatever the last baseline comparison selected. */
  policy: RankingPolicy | 'auto';
  /** Spec 16.8 exploration share of the ranked list reserved for untested actions (default 15 %). */
  explorationShare: number;
  /** Spec 16.8 volume threshold (publications per month) before exploration applies (default 30). */
  volumeThreshold: number;
  /** Spec 16.8 baseline comparison: the learned ranking must beat the baseline by this margin (score units). */
  baselineMargin: number;
}

export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  policy: 'auto',
  explorationShare: 0.15,
  volumeThreshold: 30,
  baselineMargin: 0.05,
};

/** Configuration (Appendix A names): INTELLIGENCE_RANKER, INTELLIGENCE_EXPLORATION_SHARE, INTELLIGENCE_VOLUME_THRESHOLD. */
export function rankingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RankingConfig {
  const policy = env['INTELLIGENCE_RANKER'];
  const num = (v: string | undefined, fallback: number) => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    policy:
      policy === 'baseline' || policy === 'learned' || policy === 'exploration' || policy === 'auto'
        ? policy
        : DEFAULT_RANKING_CONFIG.policy,
    explorationShare: Math.min(
      0.5,
      num(env['INTELLIGENCE_EXPLORATION_SHARE'], DEFAULT_RANKING_CONFIG.explorationShare),
    ),
    volumeThreshold: num(env['INTELLIGENCE_VOLUME_THRESHOLD'], DEFAULT_RANKING_CONFIG.volumeThreshold),
    baselineMargin: num(env['INTELLIGENCE_BASELINE_MARGIN'], DEFAULT_RANKING_CONFIG.baselineMargin),
  };
}

const COST = { low: 0, medium: 1, high: 2 } as const;
export const VERDICT_SCORE = { supported: 1, inconclusive: 0.5, not_supported: 0 } as const;

/** Spec 16.1: alignment with the brand objective decides first; a like-count metric never outranks the objective. */
export function objectiveAlignment(item: Rankable, objective: RankingObjective): number {
  if (item.expectedBenefit.metricKey === objective.primaryMetricKey) return 2;
  if (objective.guardrailMetricKeys.includes(item.expectedBenefit.metricKey)) return 1;
  return 0;
}

const byId = (a: Rankable, b: Rankable) => a.id.localeCompare(b.id);

/**
 * Stable baseline policy (spec 16.8): objective alignment, then lowest effort, then lowest uncertainty. It never
 * learns, so the learned ranker is always measured against the same yardstick.
 */
export function rankBaseline(items: readonly Rankable[], objective: RankingObjective): Rankable[] {
  return [...items].sort(
    (a, b) =>
      objectiveAlignment(b, objective) - objectiveAlignment(a, objective) ||
      COST[a.effort] - COST[b.effort] ||
      COST[a.uncertainty] - COST[b.uncertainty] ||
      byId(a, b),
  );
}

/** Mean outcome of past closed loops for (action, metric) of this brand; null when the pair was never tried. */
export function historicalSuccess(
  history: readonly OutcomeHistory[],
  action: string,
  metricKey: string,
): number | null {
  const relevant = history.filter((h) => h.action === action && h.metricKey === metricKey);
  if (relevant.length === 0) return null;
  return relevant.reduce((s, h) => s + VERDICT_SCORE[h.verdict], 0) / relevant.length;
}

export function learnedScore(
  item: Rankable,
  objective: RankingObjective,
  history: readonly OutcomeHistory[],
): number {
  const success = historicalSuccess(history, item.proposedAction, item.expectedBenefit.metricKey);
  return (
    objectiveAlignment(item, objective) * 3 +
    (success ?? 0.5) * 2 -
    COST[item.effort] * 0.5 -
    COST[item.uncertainty] * 0.5
  );
}

/** Learned ranking: the baseline signal plus what the brand's own closed loops say (tenant and brand scoped input). */
export function rankLearned(
  items: readonly Rankable[],
  objective: RankingObjective,
  history: readonly OutcomeHistory[],
): Rankable[] {
  return [...items].sort(
    (a, b) => learnedScore(b, objective, history) - learnedScore(a, objective, history) || byId(a, b),
  );
}

/**
 * Spec 16.8 exploration: once the brand has the volume, a share of the top of the list is reserved for actions
 * the brand has never tried, so the ranking does not narrow to yesterday's apparent winner.
 */
export function applyExploration(
  ranked: readonly Rankable[],
  history: readonly OutcomeHistory[],
  config: Pick<RankingConfig, 'explorationShare' | 'volumeThreshold'>,
  volume: number,
): Rankable[] {
  if (volume < config.volumeThreshold || ranked.length < 2) return [...ranked];
  const slots = Math.max(1, Math.floor(ranked.length * config.explorationShare));
  const tried = new Set(history.map((h) => `${h.action}:${h.metricKey}`));
  // The untested approaches the ranker would bury (from the tail) are the ones exploration surfaces.
  const untested = ranked
    .filter((r) => !tried.has(`${r.proposedAction}:${r.expectedBenefit.metricKey}`))
    .reverse();
  const promoted = untested.slice(0, slots);
  if (promoted.length === 0) return [...ranked];
  const rest = ranked.filter((r) => !promoted.includes(r));
  // Exploration slots are interleaved from position 2 so the top recommendation stays the best-supported one.
  const out: Rankable[] = [];
  let p = 0;
  for (const r of rest) {
    out.push(r);
    if (out.length >= 1 && p < promoted.length) out.push(promoted[p++] as Rankable);
  }
  while (p < promoted.length) out.push(promoted[p++] as Rankable);
  return out;
}

/**
 * Spec 16.8 baseline comparison: a ranking is scored on later, unseen outcomes by discounted cumulative gain
 * normalised by the ideal ordering (1 = the ranking put the best outcomes first). Items without an outcome do not
 * count.
 */
export function scoreRanking(order: readonly string[], outcomes: ReadonlyMap<string, number>): number | null {
  const scored = order.filter((id) => outcomes.has(id));
  if (scored.length === 0) return null;
  const dcg = scored.reduce((s, id, i) => s + (outcomes.get(id) as number) / Math.log2(i + 2), 0);
  const ideal = [...scored]
    .map((id) => outcomes.get(id) as number)
    .sort((a, b) => b - a)
    .reduce((s, v, i) => s + v / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

export interface BaselineComparison {
  learnedScore: number | null;
  baselineScore: number | null;
  margin: number;
  beaten: boolean;
  selected: RankingPolicy;
}

/** The learned ranking is used only when it beats the stable baseline by the stated margin; otherwise the baseline. */
export function compareRankings(
  items: readonly Rankable[],
  objective: RankingObjective,
  history: readonly OutcomeHistory[],
  outcomes: ReadonlyMap<string, number>,
  margin: number,
): BaselineComparison {
  const learned = scoreRanking(
    rankLearned(items, objective, history).map((r) => r.id),
    outcomes,
  );
  const baseline = scoreRanking(
    rankBaseline(items, objective).map((r) => r.id),
    outcomes,
  );
  const beaten = learned !== null && baseline !== null && learned > baseline + margin;
  return {
    learnedScore: learned,
    baselineScore: baseline,
    margin,
    beaten,
    selected: beaten ? 'learned' : 'baseline',
  };
}
