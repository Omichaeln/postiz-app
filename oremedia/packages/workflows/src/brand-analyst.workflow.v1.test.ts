import { describe, expect, it } from 'vitest';
import type {
  BrandAnalystWorkflowInputV1,
  ReadAnalystRunInputV1,
  RecordAnalystOutcomeInputV1,
} from '@oremedia/contracts/intelligence';
import {
  RUN_POLL_INTERVAL_MS,
  RUN_WAIT_LIMIT_MS,
  analystWorkflowId,
  runAnalystSweep,
  runBrandAnalyst,
} from './brand-analyst.workflow.v1';

const input: BrandAnalystWorkflowInputV1 = {
  tenantId: 'ten_a',
  actor: { kind: 'service_principal', id: 'sp_analyst' },
  correlationId: 'corr_analyst',
  brandId: 'brand_a',
  servicePrincipalId: 'sp_analyst',
  periodStart: '2026-09-17T00:00:00.000Z',
  periodEnd: '2026-09-24T00:00:00.000Z',
};
const coverage = {
  sources: ['qualified_enquiries'],
  competitors: [],
  languages: [],
  periodStart: input.periodStart,
  periodEnd: input.periodEnd,
};

describe('brandAnalystWorkflowV1 (spec 16.3)', () => {
  it('prepares, polls the performance-review run until it ends, then records and ranks the outcome', async () => {
    const reads: ReadAnalystRunInputV1[] = [];
    const sleeps: number[] = [];
    let recorded: RecordAnalystOutcomeInputV1 | null = null;
    const states = ['planned', 'running', 'running', 'completed'];
    const outcome = await runBrandAnalyst(
      {
        prepareAnalysis: async () => ({
          runId: 'run_1',
          skippedReason: null,
          changeInsightIds: ['ins_1', 'ins_2'],
          coverage,
        }),
        readAnalystRun: async (i) => {
          reads.push(i);
          const state = states[reads.length - 1] ?? 'completed';
          return { state, terminal: state === 'completed' };
        },
        recordAnalystOutcome: async (i) => {
          recorded = i;
          return { insights: 3, recommendations: 2, rankingPolicy: 'baseline' };
        },
      },
      input,
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(reads).toHaveLength(4);
    expect(reads[0]).toMatchObject({ runId: 'run_1', brandId: 'brand_a' });
    expect(sleeps).toEqual([RUN_POLL_INTERVAL_MS, RUN_POLL_INTERVAL_MS, RUN_POLL_INTERVAL_MS]);
    expect(recorded).toMatchObject({
      runId: 'run_1',
      runState: 'completed',
      changeInsightIds: ['ins_1', 'ins_2'],
    });
    expect(outcome).toEqual({
      outcome: 'recorded',
      runId: 'run_1',
      runState: 'completed',
      insights: 3,
      recommendations: 2,
      rankingPolicy: 'baseline',
    });
  });

  it('skips cleanly (no run, nothing recorded) when the analysis could not start', async () => {
    let recorded = 0;
    const outcome = await runBrandAnalyst(
      {
        prepareAnalysis: async () => ({
          runId: null,
          skippedReason: 'no_active_objective',
          changeInsightIds: [],
          coverage,
        }),
        readAnalystRun: async () => {
          throw new Error('never read');
        },
        recordAnalystOutcome: async () => {
          recorded += 1;
          return { insights: 0, recommendations: 0, rankingPolicy: 'baseline' };
        },
      },
      input,
      { sleep: async () => undefined },
    );
    expect(outcome).toEqual({ outcome: 'skipped', reason: 'no_active_objective', changeInsights: 0 });
    expect(recorded).toBe(0);
  });

  it('records the movements even when the run could not start, and stops waiting at the limit', async () => {
    let reads = 0;
    let waited = 0;
    const outcome = await runBrandAnalyst(
      {
        prepareAnalysis: async () => ({
          runId: 'run_2',
          skippedReason: null,
          changeInsightIds: ['ins_1'],
          coverage,
        }),
        readAnalystRun: async () => {
          reads += 1;
          return { state: 'running', terminal: false };
        },
        recordAnalystOutcome: async (i) => ({
          insights: i.changeInsightIds.length,
          recommendations: 0,
          rankingPolicy: 'baseline',
        }),
      },
      input,
      { sleep: async (ms) => void (waited += ms) },
    );
    expect(waited).toBe(RUN_WAIT_LIMIT_MS);
    expect(reads).toBe(RUN_WAIT_LIMIT_MS / RUN_POLL_INTERVAL_MS + 1);
    expect(outcome).toMatchObject({
      outcome: 'recorded',
      runId: 'run_2',
      runState: 'wait_limit:running',
      insights: 1,
    });
  });
});

describe('brandAnalystSweepWorkflowV1 (weekly schedule)', () => {
  it('starts one analysis per target with a stable per-day workflow id and counts failures without stopping', async () => {
    const started: Array<{ brandId: string; workflowId: string; tenantId: string; periodStart: string }> = [];
    const result = await runAnalystSweep(
      {
        listAnalystTargets: async () => [
          { tenantId: 'ten_a', brandId: 'brand_a', servicePrincipalId: 'sp_a' },
          { tenantId: 'ten_b', brandId: 'brand_b', servicePrincipalId: 'sp_b' },
          { tenantId: 'ten_c', brandId: 'brand_c', servicePrincipalId: 'sp_c' },
        ],
      },
      { correlationId: 'sweep_1', now: '2026-09-24T03:00:00.000Z' },
      {
        startAnalysis: async (child, workflowId) => {
          if (child.brandId === 'brand_b') throw new Error('already running');
          started.push({
            brandId: child.brandId,
            workflowId,
            tenantId: child.tenantId,
            periodStart: child.periodStart,
          });
        },
      },
    );
    expect(result).toEqual({ started: 2, failed: 1 });
    expect(started.map((s) => s.workflowId)).toEqual([
      analystWorkflowId('brand_a', '2026-09-24T03:00:00.000Z'),
      'brand-analyst:brand_c:2026-09-24',
    ]);
    expect(started[0]).toMatchObject({ tenantId: 'ten_a', periodStart: '2026-09-17T03:00:00.000Z' });
  });
});
