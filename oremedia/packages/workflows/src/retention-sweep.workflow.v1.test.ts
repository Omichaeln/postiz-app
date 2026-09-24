import { describe, expect, it } from 'vitest';
import type { RetentionActivitiesV1 } from '@oremedia/contracts/operations';
import { runRetentionSweep } from './retention-sweep.workflow.v1';

const input = { correlationId: 'c', now: '2026-09-24T02:00:00.000Z', dryRun: true };

describe('retentionSweepWorkflowV1 orchestration (spec 17.5)', () => {
  it('applies retention per tenant, passing dryRun through, and sums the rows', async () => {
    const seen: Array<{ tenantId: string; dryRun: boolean }> = [];
    const acts: RetentionActivitiesV1 = {
      listRetentionTenants: async () => ['ten_A', 'ten_B'],
      applyRetention: async ({ tenantId, dryRun }) => {
        seen.push({ tenantId, dryRun });
        return {
          tenantId,
          dryRun,
          classes: [
            { dataClass: 'agent_transcripts', handler: 'agents', retentionDays: 90, cutoff: 'x', rows: 2 },
          ],
        };
      },
    };
    expect(await runRetentionSweep(acts, input)).toEqual({ dryRun: true, tenants: 2, failed: 0, rows: 4 });
    expect(seen).toEqual([
      { tenantId: 'ten_A', dryRun: true },
      { tenantId: 'ten_B', dryRun: true },
    ]);
  });
  it("one tenant's failure never blocks the others", async () => {
    const acts: RetentionActivitiesV1 = {
      listRetentionTenants: async () => ['ten_A', 'ten_B'],
      applyRetention: async ({ tenantId, dryRun }) => {
        if (tenantId === 'ten_A') throw new Error('boom');
        return { tenantId, dryRun, classes: [] };
      },
    };
    expect(await runRetentionSweep(acts, { ...input, dryRun: false })).toEqual({
      dryRun: false,
      tenants: 1,
      failed: 1,
      rows: 0,
    });
  });
});
