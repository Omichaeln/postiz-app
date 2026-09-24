import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelToolCall } from '@oremedia/contracts/agents';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { TenantContext, Tx } from '@oremedia/db';
import { MemoryProviderJobStore } from './provider-jobs';
import {
  dispatchToolDetailed,
  toolCallChargeKey,
  type AgentRunContext,
  type DispatchDeps,
} from './tool-dispatcher';
import { createReleaseOneRegistry } from './tools';
import type { ImageGenerator, ToolServices } from './tools/services';

/**
 * Spec 18 (expensive generation → runaway cost) and spec 12.2 model-call recovery: once an image provider has
 * accepted a job, a retry of the same step (Temporal re-running the activity after a provider or worker timeout)
 * polls the persisted job id and never submits a second, billable generation.
 */
const principal: ResolvedActorServicePrincipal = {
  kind: 'service_principal',
  id: 'sp_01HAGENT0000000000000000000',
  tenantId: 'ten_A',
  status: 'active',
  maxAutonomy: 'create',
  grants: [],
};
const tenantContext: TenantContext = {
  tenantId: 'ten_A',
  actor: { kind: 'service_principal', id: principal.id },
  brandIds: 'all',
  correlationId: 'corr_jobs',
};
const run = (stepId: string): AgentRunContext => ({
  runId: 'run_jobs',
  stepId,
  tenantId: 'ten_A',
  brandId: 'brd_1',
  correlationId: 'corr_jobs',
  tenantContext,
  principal,
  policy: { autonomyMode: 'create', allowedTools: ['images.generate'] },
  budgetReservationId: 'bres_1',
  snapshot: null,
});
const call: ModelToolCall = {
  id: 'toolu_img',
  name: 'images.generate',
  arguments: { prompt: 'autumn storefront', count: 2 },
};
const DONE = {
  status: 'done' as const,
  images: [
    {
      storageKey: 'assets/ten_A/brd_1/generated/1.png',
      contentHash: 'a'.repeat(64),
      width: 1024,
      height: 1024,
    },
  ],
};

function harness(poll: ImageGenerator['poll']) {
  const submits: string[] = [];
  const polls: string[] = [];
  const charges: Array<{ sourceRef: string; idempotencyKey: string | undefined }> = [];
  const generator: ImageGenerator = {
    provider: 'fake-images',
    async submit(input) {
      submits.push(input.prompt);
      return { jobId: `job_${submits.length}` };
    },
    async poll(jobId) {
      polls.push(jobId);
      return poll(jobId);
    },
  };
  const deps: DispatchDeps = {
    registry: createReleaseOneRegistry(),
    policy: { decide: async () => ({ allowed: true, reason: 'ok' }) },
    audit: { record: async () => 'aud_1' },
    budgets: {
      consume: async (_r, _b, _k, _q, _u, _c, sourceRef, idempotencyKey) => {
        charges.push({ sourceRef, idempotencyKey });
      },
    },
    services: { images: generator } as unknown as ToolServices,
    providerJobs: new MemoryProviderJobStore(),
    transaction: (fn) => fn({} as Tx),
  };
  return { deps, submits, polls, charges };
}

describe('images.generate through provider jobs: retry after acceptance polls, never resubmits', () => {
  afterEach(() => vi.useRealTimers());

  it('the provider accepted, then the poll timed out: the retried activity polls the same job; one submission', async () => {
    let first = true;
    const h = harness(async () => {
      if (first) {
        first = false;
        throw Object.assign(new Error('provider poll timed out'), { code: 'ETIMEDOUT' });
      }
      return DONE;
    });
    // Attempt 1: an infrastructure failure after acceptance propagates, so Temporal retries the activity.
    await expect(dispatchToolDetailed(call, run('step_1'), h.deps)).rejects.toThrow(/timed out/);
    expect(h.submits).toHaveLength(1);
    // Attempt 2 (same run, same step): the persisted job id is polled.
    const retried = await dispatchToolDetailed(call, run('step_1'), h.deps);
    expect(retried.result).toEqual({ kind: 'ok', output: { jobId: 'job_1', images: DONE.images } });
    expect(h.submits).toHaveLength(1);
    expect(h.polls).toEqual(['job_1', 'job_1']);
  });

  it('a tool timeout while the provider is still processing is denied tool_timeout; the same step then polls, not resubmits', async () => {
    vi.useFakeTimers();
    let ready = false;
    const h = harness(async () => (ready ? DONE : { status: 'pending' }));
    const attempt = dispatchToolDetailed(call, run('step_2'), h.deps);
    await vi.advanceTimersByTimeAsync(181_000); // images.generate's own 180 s deadline
    expect((await attempt).result).toEqual({ kind: 'denied', reason: 'tool_timeout' });
    expect(h.submits).toHaveLength(1);
    ready = true;
    const again = dispatchToolDetailed(call, run('step_2'), h.deps);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await again).result).toMatchObject({ kind: 'ok', output: { jobId: 'job_1' } });
    expect(h.submits).toHaveLength(1);
    expect(new Set(h.polls)).toEqual(new Set(['job_1']));
  });

  it('a provider failure after acceptance is a denial with its reason, and nothing is resubmitted', async () => {
    const h = harness(async () => ({ status: 'failed', reason: 'content_policy' }));
    const out = await dispatchToolDetailed(call, run('step_3'), h.deps);
    expect(out.result).toEqual({ kind: 'denied', reason: 'provider_failed:content_policy' });
    expect(h.submits).toHaveLength(1);
  });

  it('control: a different step is a new request and submits its own job', async () => {
    const h = harness(async () => DONE);
    await dispatchToolDetailed(call, run('step_4'), h.deps);
    await dispatchToolDetailed(call, run('step_5'), h.deps);
    expect(h.submits).toHaveLength(2);
  });

  it('two images.generate calls in one model step each get their own job; a retry of either polls its own', async () => {
    let failFirstPolls = 2;
    const h = harness(async () => {
      if (failFirstPolls > 0) {
        failFirstPolls -= 1;
        throw Object.assign(new Error('provider poll timed out'), { code: 'ETIMEDOUT' });
      }
      return DONE;
    });
    const first: ModelToolCall = { ...call, id: 'toolu_img_a' };
    const second: ModelToolCall = { ...call, id: 'toolu_img_b', arguments: { prompt: 'winter storefront' } };
    await expect(dispatchToolDetailed(first, run('step_6'), h.deps)).rejects.toThrow(/timed out/);
    await expect(dispatchToolDetailed(second, run('step_6'), h.deps)).rejects.toThrow(/timed out/);
    expect(h.submits).toEqual(['autumn storefront', 'winter storefront']); // two calls, two jobs
    const retriedSecond = await dispatchToolDetailed(second, run('step_6'), h.deps);
    const retriedFirst = await dispatchToolDetailed(first, run('step_6'), h.deps);
    expect(retriedSecond.result).toMatchObject({ kind: 'ok', output: { jobId: 'job_2' } });
    expect(retriedFirst.result).toMatchObject({ kind: 'ok', output: { jobId: 'job_1' } });
    expect(h.submits).toHaveLength(2); // the retries submitted nothing
    expect(h.polls).toEqual(['job_1', 'job_2', 'job_2', 'job_1']);
  });

  it('every charge carries the tool call identity: a retry repeats its key, a distinct call in the same step does not', async () => {
    let first = true;
    const h = harness(async () => {
      if (first) {
        first = false;
        throw Object.assign(new Error('provider poll timed out'), { code: 'ETIMEDOUT' });
      }
      return DONE;
    });
    const a: ModelToolCall = { ...call, id: 'toolu_img_c' };
    const b: ModelToolCall = { ...call, id: 'toolu_img_d' };
    await expect(dispatchToolDetailed(a, run('step_7'), h.deps)).rejects.toThrow(/timed out/);
    await dispatchToolDetailed(a, run('step_7'), h.deps); // the retried activity
    await dispatchToolDetailed(b, run('step_7'), h.deps);
    const keyA = toolCallChargeKey(run('step_7'), a);
    const keyB = toolCallChargeKey(run('step_7'), b);
    expect(h.charges.map((c) => c.idempotencyKey)).toEqual([keyA, keyA, keyB]);
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(toolCallChargeKey(run('step_8'), a)); // the same tool_use id in another step
    expect(keyA.length).toBeLessThanOrEqual(200); // usage_ledger.idempotency_key
  });
});
