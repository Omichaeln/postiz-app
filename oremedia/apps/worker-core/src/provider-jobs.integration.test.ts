import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ModelToolCall } from '@oremedia/contracts/agents';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, type TenantContext } from '@oremedia/db';
import { servicePrincipals, tenants, users } from '@oremedia/db/schema/access';
import { agentRuns, providerJobs } from '@oremedia/db/schema/agents';
import { usageLedger } from '@oremedia/db/schema/billing';
import { brands } from '@oremedia/db/schema/brand';
import {
  MemoryProviderJobStore,
  createReleaseOneRegistry,
  defaultDispatchDeps,
  dispatchToolDetailed,
  registerProviderJobStore,
  type AgentRunContext,
  type DispatchDeps,
  type ImageGenerator,
} from '@oremedia/ai';
import { budgets } from '@oremedia/module-billing';
import { composeModules } from './composition';

/**
 * Ledger 4.10 / S.9 against MySQL with the worker-core composition: images.generate persists the provider's job id
 * in provider_jobs before it waits, so after the worker dies mid-poll a fresh process (nothing in memory) retries
 * the activity and polls the same job: one submission, one charge. Two calls of the tool in one model step are two
 * jobs and two charges. The control shows what the in-process store did: a restart lost the job and resubmitted.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

/** The provider's side: jobs it accepted live outside the worker process and survive its restart. */
function fakeProvider() {
  const submissions: string[] = [];
  const polls: string[] = [];
  let crashNextPoll = false;
  const generator = (): ImageGenerator => ({
    provider: 'fake-images',
    async submit(input) {
      submissions.push(input.prompt);
      return { jobId: `job_${submissions.length}` };
    },
    async poll(jobId) {
      polls.push(jobId);
      if (crashNextPoll) {
        crashNextPoll = false;
        throw Object.assign(new Error('worker lost while waiting for the provider'), { code: 'ECONNRESET' });
      }
      return {
        status: 'done',
        images: [
          {
            storageKey: `assets/${jobId}/1.png`,
            contentHash: 'b'.repeat(64),
            width: 1024,
            height: 1024,
          },
        ],
      };
    },
  });
  return {
    submissions,
    polls,
    generator,
    crashOnNextPoll: () => {
      crashNextPoll = true;
    },
  };
}

describe('provider job ids are durable across a worker restart; each tool call charges once (ledger 4.10, S.9)', () => {
  let tdb: TestDatabase;
  const tenantId = newId('ten');
  const brandId = newId('brd');
  const spId = newId('sp');
  const ownerId = newId('usr');
  const principal: ResolvedActorServicePrincipal = {
    kind: 'service_principal',
    id: spId,
    tenantId,
    status: 'active',
    maxAutonomy: 'create',
    grants: [{ action: 'creative.edit', brandIds: 'all' }],
  };
  const tenantContext: TenantContext = {
    tenantId,
    actor: { kind: 'service_principal', id: spId },
    brandIds: 'all',
    correlationId: 'corr_provider_jobs',
  };

  async function newRun(): Promise<AgentRunContext> {
    const runId = newId('run');
    await tdb.db.insert(agentRuns).values({
      id: runId,
      tenantId,
      brandId,
      initiatorKind: 'user',
      initiatorId: ownerId,
      servicePrincipalId: spId,
      autonomyMode: 'create',
      taskKind: 'layout',
      brief: {},
      skillVersionIds: [],
      modelConfig: { provider: 'fake', model: 'fake' },
      state: 'running',
      deadlineAt: new Date(Date.now() + 3600_000),
      correlationId: 'corr_provider_jobs',
    });
    const reservation = await runInTenant(tenantContext, () =>
      budgets.reserveSpend(brandId, runId, 1_000_000, new Date(Date.now() + 3600_000)),
    );
    return {
      runId,
      stepId: newId('step'),
      tenantId,
      brandId,
      correlationId: 'corr_provider_jobs',
      tenantContext,
      principal,
      policy: { autonomyMode: 'create', allowedTools: ['images.generate'] },
      budgetReservationId: reservation.id,
      snapshot: null,
    };
  }

  /** What one worker process builds at start: the composition, then the runtime's default dispatch deps. */
  function startWorker(generator: ImageGenerator): DispatchDeps {
    composeModules();
    const deps = defaultDispatchDeps(createReleaseOneRegistry());
    return {
      ...deps,
      policy: { decide: async () => ({ allowed: true, reason: 'ok' }) },
      services: { ...deps.services, images: generator },
    };
  }

  const call = (id: string, prompt = 'autumn storefront'): ModelToolCall => ({
    id,
    name: 'images.generate',
    arguments: { prompt, count: 1 },
  });

  const jobsFor = (runId: string) =>
    tdb.db
      .select()
      .from(providerJobs)
      .where(and(eq(providerJobs.tenantId, tenantId), eq(providerJobs.runId, runId)));
  const chargesFor = (reservationId: string) =>
    tdb.db.select().from(usageLedger).where(eq(usageLedger.reservationId, reservationId));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values({ id: tenantId, name: 'PJ', slug: `pj-${tenantId.slice(-8)}` });
    await tdb.db.insert(users).values({ id: ownerId, email: `${ownerId}@example.test`, name: 'Owner' });
    await tdb.db.insert(brands).values({
      id: brandId,
      tenantId,
      name: 'PJ brand',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await tdb.db.insert(servicePrincipals).values({
      id: spId,
      tenantId,
      kind: 'agent',
      name: 'agent',
      grants: [{ action: 'creative.edit', brandIds: 'all' }],
      maxAutonomy: 'create',
      status: 'active',
      createdByUserId: ownerId,
    });
  });
  afterEach(() => composeModules());
  afterAll(async () => {
    await tdb?.drop();
  });

  it('the worker dies after the provider accepted; a fresh process retries the call and polls the same job: one submission, one charge', async () => {
    const provider = fakeProvider();
    const run = await newRun();
    provider.crashOnNextPoll();
    await expect(
      dispatchToolDetailed(call('toolu_crash'), run, startWorker(provider.generator())),
    ).rejects.toThrow(/worker lost/);
    expect(provider.submissions).toHaveLength(1);
    const persisted = await jobsFor(run.runId);
    expect(persisted).toMatchObject([
      {
        brandId,
        stepId: run.stepId,
        toolName: 'images.generate',
        toolCallId: 'toolu_crash',
        provider: 'fake-images',
        providerJobId: 'job_1',
        status: 'submitted',
      },
    ]); // committed although the tool's own transaction rolled back

    // Restart: new composition, new store instance, new generator object; only the database and the provider remain.
    const retried = await dispatchToolDetailed(call('toolu_crash'), run, startWorker(provider.generator()));
    expect(retried.result).toMatchObject({ kind: 'ok', output: { jobId: 'job_1' } });
    expect(provider.submissions).toHaveLength(1);
    expect(provider.polls).toEqual(['job_1', 'job_1']);
    expect((await jobsFor(run.runId)).map((j) => j.status)).toEqual(['succeeded']);
    expect(await chargesFor(run.budgetReservationId as string)).toHaveLength(1); // S.9a: the retry charged nothing
  });

  it('two images.generate calls in one model step are two jobs and two charges; retrying either reuses its own', async () => {
    const provider = fakeProvider();
    const run = await newRun();
    const deps = startWorker(provider.generator());
    await dispatchToolDetailed(call('toolu_a', 'first'), run, deps);
    await dispatchToolDetailed(call('toolu_b', 'second'), run, deps);
    await dispatchToolDetailed(call('toolu_a', 'first'), run, startWorker(provider.generator())); // a retry of a
    expect(provider.submissions).toEqual(['first', 'second']);
    const jobs = await jobsFor(run.runId);
    expect(jobs.map((j) => [j.toolCallId, j.providerJobId]).sort()).toEqual([
      ['toolu_a', 'job_1'],
      ['toolu_b', 'job_2'],
    ]);
    expect(await chargesFor(run.budgetReservationId as string)).toHaveLength(2);
  });

  it('control: with the in-process store a restart loses the job id and the retry submits a second, billable job', async () => {
    const provider = fakeProvider();
    const run = await newRun();
    provider.crashOnNextPoll();
    const firstProcess = startWorker(provider.generator());
    registerProviderJobStore(new MemoryProviderJobStore());
    await expect(dispatchToolDetailed(call('toolu_mem'), run, firstProcess)).rejects.toThrow(/worker lost/);
    registerProviderJobStore(new MemoryProviderJobStore()); // the restarted process starts empty
    await dispatchToolDetailed(call('toolu_mem'), run, firstProcess);
    expect(provider.submissions).toHaveLength(2);
  });
});
