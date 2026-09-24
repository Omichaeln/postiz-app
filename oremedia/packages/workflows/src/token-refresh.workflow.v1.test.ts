import { describe, expect, it } from 'vitest';
import type { RefreshCredentialsResultV1, TokenRefreshActivitiesV1 } from '@oremedia/contracts/publishing';
import {
  REFRESH_MARGIN_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  runTokenRefreshCycle,
} from './token-refresh.workflow.v1';

const input = {
  tenantId: 'ten_A',
  actor: { kind: 'user' as const, id: 'usr_1' },
  correlationId: 'c',
  channelConnectionId: 'cc_1',
};
const T0 = Date.parse('2026-09-24T10:00:00.000Z');

function fakes(opts: {
  statuses?: Array<'active' | 'disabled' | 'refresh_needed'>;
  expiresAt?: string | null;
  results?: RefreshCredentialsResultV1[];
}) {
  const names: string[] = [];
  const sleeps: number[] = [];
  let clock = T0;
  const statuses = [...(opts.statuses ?? ['active'])];
  const results = [...(opts.results ?? [{ ok: true, tokenExpiresAt: null }])];
  const acts: TokenRefreshActivitiesV1 = {
    readRefreshSchedule: async () => {
      names.push('readRefreshSchedule');
      const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
      return {
        status,
        tokenExpiresAt:
          opts.expiresAt === undefined ? new Date(T0 + 3_600_000).toISOString() : opts.expiresAt,
      };
    },
    refreshCredentials: async () => {
      names.push('refreshCredentials');
      return results.length > 1 ? results.shift()! : results[0]!;
    },
  };
  const host = {
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
  };
  return { acts, host, names, sleeps };
}

describe('tokenRefreshWorkflowV1 cycle (spec 14.7, ported from Postiz refresh.token.workflow)', () => {
  it('sleeps until tokenExpiresAt - margin, re-reads the row, refreshes', async () => {
    const f = fakes({});
    expect(await runTokenRefreshCycle(f.acts, input, f.host)).toBe('refreshed');
    expect(f.names).toEqual(['readRefreshSchedule', 'readRefreshSchedule', 'refreshCredentials']);
    expect(f.sleeps).toEqual([3_600_000 - REFRESH_MARGIN_MS]);
  });
  it('a connection disconnected while sleeping is left alone', async () => {
    const f = fakes({ statuses: ['active', 'disabled'] });
    expect(await runTokenRefreshCycle(f.acts, input, f.host)).toBe('not_active');
    expect(f.names).not.toContain('refreshCredentials');
  });
  it('no expiry: nothing to refresh', async () => {
    const f = fakes({ expiresAt: null });
    expect(await runTokenRefreshCycle(f.acts, input, f.host)).toBe('no_expiry');
  });
  it('reconnect_required ends the cycle; the row was flagged by the activity', async () => {
    const f = fakes({ results: [{ ok: false, reason: 'reconnect_required' }] });
    expect(await runTokenRefreshCycle(f.acts, input, f.host)).toBe('reconnect_needed');
  });
  it('transient failures (or a held lock) are retried on the spaced schedule, then left refresh_needed', async () => {
    const f = fakes({
      results: [
        { ok: false, reason: 'locked' },
        { ok: false, reason: 'transient' },
      ],
    });
    expect(await runTokenRefreshCycle(f.acts, input, f.host)).toBe('refresh_needed');
    expect(f.sleeps.slice(1)).toEqual([...TRANSIENT_RETRY_DELAYS_MS]);
    expect(f.names.filter((n) => n === 'refreshCredentials')).toHaveLength(
      TRANSIENT_RETRY_DELAYS_MS.length + 1,
    );
  });
});
