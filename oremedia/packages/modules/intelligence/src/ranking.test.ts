import { describe, expect, it } from 'vitest';
import {
  applyExploration,
  compareRankings,
  rankBaseline,
  rankLearned,
  rankingConfigFromEnv,
  scoreRanking,
  type OutcomeHistory,
  type Rankable,
} from './ranking';

const objective = { primaryMetricKey: 'qualified_enquiries', guardrailMetricKeys: ['complaints'] };
const item = (id: string, over: Partial<Rankable> = {}): Rankable => ({
  id,
  proposedAction: 'create_brief',
  expectedBenefit: { metricKey: 'qualified_enquiries', direction: 'up' },
  effort: 'medium',
  uncertainty: 'medium',
  ...over,
});

describe('recommendation ranking (spec 16.1, 16.8)', () => {
  it('the baseline ranks objective alignment first: the most-liked post never beats a qualified-enquiry action', () => {
    const order = rankBaseline(
      [
        item('likes_low_effort', {
          expectedBenefit: { metricKey: 'likes', direction: 'up' },
          effort: 'low',
          uncertainty: 'low',
        }),
        item('guardrail'),
        item('objective_high_effort', { effort: 'high' }),
        item('objective_low_effort', { effort: 'low' }),
      ].map((r) =>
        r.id === 'guardrail'
          ? { ...r, expectedBenefit: { metricKey: 'complaints', direction: 'down' as const } }
          : r,
      ),
      objective,
    ).map((r) => r.id);
    expect(order).toEqual(['objective_low_effort', 'objective_high_effort', 'guardrail', 'likes_low_effort']);
  });

  it("the learned ranker uses only the history it is given (the brand's own closed loops)", () => {
    const history: OutcomeHistory[] = [
      { action: 'prepare_test', metricKey: 'qualified_enquiries', verdict: 'supported' },
      { action: 'create_brief', metricKey: 'qualified_enquiries', verdict: 'not_supported' },
    ];
    const items = [item('brief'), item('test', { proposedAction: 'prepare_test' })];
    expect(rankLearned(items, objective, history).map((r) => r.id)).toEqual(['test', 'brief']);
    expect(rankLearned(items, objective, []).map((r) => r.id)).toEqual(['brief', 'test']); // no history: ties break by id
  });

  it('exploration surfaces an untested approach only once the volume threshold is met', () => {
    const history: OutcomeHistory[] = [
      { action: 'create_brief', metricKey: 'qualified_enquiries', verdict: 'supported' },
    ];
    const ranked = [
      item('a'),
      item('b'),
      item('c'),
      item('untested', { proposedAction: 'propose_playbook_update', effort: 'high' }),
    ];
    const cfg = { explorationShare: 0.25, volumeThreshold: 30 };
    expect(applyExploration(ranked, history, cfg, 10).map((r) => r.id)).toEqual(['a', 'b', 'c', 'untested']);
    expect(applyExploration(ranked, history, cfg, 30).map((r) => r.id)).toEqual(['a', 'untested', 'b', 'c']);
  });

  it('scores a ranking on later outcomes and falls back to the baseline unless the learned ranking beats it by the margin', () => {
    const outcomes = new Map([
      ['x', 1],
      ['y', 0],
      ['z', 0.5],
    ]);
    expect(scoreRanking(['x', 'z', 'y'], outcomes)).toBe(1);
    expect(scoreRanking(['y', 'z', 'x'], outcomes)).toBeLessThan(1);
    expect(scoreRanking(['unknown'], outcomes)).toBeNull();
    // The baseline buries x (high effort); the brand's history says tests on the objective win.
    const items = [
      item('x', { proposedAction: 'prepare_test', effort: 'high' }),
      item('y'),
      item('z', { proposedAction: 'generate_variants' }),
    ];
    const history: OutcomeHistory[] = [
      { action: 'prepare_test', metricKey: 'qualified_enquiries', verdict: 'supported' },
      { action: 'create_brief', metricKey: 'qualified_enquiries', verdict: 'not_supported' },
    ];
    const beaten = compareRankings(items, objective, history, outcomes, 0.05);
    expect(beaten.baselineScore).toBeLessThan(0.7);
    expect(beaten.learnedScore).toBe(1);
    expect(beaten.beaten).toBe(true);
    expect(beaten.selected).toBe('learned');
    const noHistory = compareRankings(items, objective, [], outcomes, 0.05);
    expect(noHistory.beaten).toBe(false);
    expect(noHistory.selected).toBe('baseline');
  });

  it('reads the ranker and shares from configuration with safe defaults', () => {
    expect(rankingConfigFromEnv({})).toEqual({
      policy: 'auto',
      explorationShare: 0.15,
      volumeThreshold: 30,
      baselineMargin: 0.05,
    });
    expect(
      rankingConfigFromEnv({
        INTELLIGENCE_RANKER: 'learned',
        INTELLIGENCE_EXPLORATION_SHARE: '0.9',
        INTELLIGENCE_VOLUME_THRESHOLD: '5',
      }),
    ).toMatchObject({ policy: 'learned', explorationShare: 0.5, volumeThreshold: 5 });
    expect(rankingConfigFromEnv({ INTELLIGENCE_RANKER: 'nonsense' }).policy).toBe('auto');
  });
});
