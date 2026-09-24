import { describe, expect, it } from 'vitest';
import type { CompareRankingInputV1 } from '@oremedia/contracts/intelligence';
import { COMPARISON_PERIOD_DAYS, runBaselineComparison } from './baseline-comparison.workflow.v1';

describe('baselineComparisonWorkflowV1 (spec 16.8 monthly baseline comparison)', () => {
  it('compares every target over the last 30 days as its service principal, counting fallbacks and failures', async () => {
    const inputs: CompareRankingInputV1[] = [];
    const summary = await runBaselineComparison(
      {
        listBaselineTargets: async () => [
          { tenantId: 'ten_a', brandId: 'brand_a', servicePrincipalId: 'sp_a' },
          { tenantId: 'ten_a', brandId: 'brand_a2', servicePrincipalId: 'sp_a' },
          { tenantId: 'ten_b', brandId: 'brand_b', servicePrincipalId: 'sp_b' },
        ],
        compareRankingBaseline: async (i) => {
          inputs.push(i);
          if (i.brandId === 'brand_b') throw new Error('policy denied');
          const beaten = i.brandId === 'brand_a2';
          return {
            brandId: i.brandId,
            evaluated: 4,
            learnedScore: beaten ? 0.9 : 0.6,
            baselineScore: 0.7,
            margin: 0.05,
            beaten,
            selected: beaten ? 'learned' : 'baseline',
            insightId: `ins_${i.brandId}`,
          };
        },
      },
      { correlationId: 'baseline_1', now: '2026-10-01T02:00:00.000Z' },
    );
    expect(summary.compared).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.fallbacks).toBe(1);
    expect(summary.results.map((r) => r.selected)).toEqual(['baseline', 'learned']);
    expect(inputs[0]).toMatchObject({
      tenantId: 'ten_a',
      actor: { kind: 'service_principal', id: 'sp_a' },
      correlationId: 'baseline_1:brand_a',
      periodEnd: '2026-10-01T02:00:00.000Z',
      periodStart: new Date(
        Date.parse('2026-10-01T02:00:00.000Z') - COMPARISON_PERIOD_DAYS * 86_400_000,
      ).toISOString(),
    });
  });
});
