import { describe, expect, it } from 'vitest';
import type { PublicationSweepInputV1 } from '@oremedia/contracts/publishing';
import { SWEEPER_DEFAULTS, runSweeperPasses } from './publication-sweeper.workflow.v1';

describe('publicationSweeperWorkflowV1 (always-on safety net)', () => {
  it('sweeps on the interval with the lease and grace it was configured with, and totals what it found', async () => {
    const inputs: PublicationSweepInputV1[] = [];
    const sleeps: number[] = [];
    let clock = Date.parse('2026-09-24T10:00:00.000Z');
    const total = await runSweeperPasses(
      {
        sweepPublications: async (i) => {
          inputs.push(i);
          return { scheduledReemitted: 1, dispatchingExpired: inputs.length === 2 ? 1 : 0 };
        },
      },
      { ...SWEEPER_DEFAULTS, passesPerRun: 3, intervalSeconds: 30 },
      {
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        correlationId: (p) => `sweeper:${p}`,
      },
    );
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toMatchObject({
      correlationId: 'sweeper:0',
      claimLeaseSeconds: SWEEPER_DEFAULTS.claimLeaseSeconds,
      graceSeconds: SWEEPER_DEFAULTS.graceSeconds,
    });
    expect(inputs[1]?.now).toBe(new Date(Date.parse('2026-09-24T10:00:30.000Z')).toISOString());
    expect(sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(total).toEqual({ scheduledReemitted: 3, dispatchingExpired: 1 });
  });
});
