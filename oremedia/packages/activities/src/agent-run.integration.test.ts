import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import type { AgentRunRuntimeV1, AgentRunWorkflowInputV1 } from '@oremedia/contracts/agents';
import {
  BudgetExhaustedError,
  NotFoundError,
  PolicyDeniedError,
  StaleRevisionError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import { requireTenant } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { servicePrincipals, tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { newId } from '@oremedia/domain/ids';
import { createAgentRunActivities, toActivityFailure } from './agent-run';

/**
 * Spec 5.2 / 12.2 for the activity host: every activity re-establishes tenant context from its input and re-loads
 * the run's service-principal grants at the point of effect, heartbeats around the model call and turns domain
 * errors into the three failure types the workflow maps. The runtime is a fake here (the module's own integration
 * test drives the real one); MockActivityEnvironment supplies a real activity Context and needs no Temporal server.
 */
describe('agent run activities (MockActivityEnvironment against MySQL)', () => {
  let tdb: TestDatabase;
  const env = new MockActivityEnvironment();
  const run = <A, R>(fn: (arg: A) => Promise<R>, arg: A): Promise<R> => env.run(fn, arg) as Promise<R>;
  const tenantA = newId('tenant');
  const brandA = newId('brand');
  const spActive = newId('servicePrincipal');
  const spRevoked = newId('servicePrincipal');
  const spRestricted = newId('servicePrincipal');
  const seen: Array<{
    method: string;
    tenantId: string;
    brandIds: ReadonlySet<string> | 'all';
    hooks: boolean;
  }> = [];
  const fakeRuntime = (fail?: () => never): AgentRunRuntimeV1 => {
    const record = (method: string, hooks = false) => {
      const ctx = requireTenant();
      seen.push({ method, tenantId: ctx.tenantId, brandIds: ctx.brandIds, hooks });
      if (fail) fail();
    };
    return {
      async resolveContextSnapshot() {
        record('resolveContextSnapshot');
        return {
          hash: 'h',
          autonomyMode: 'create',
          allowedTools: [],
          budget: { maxSteps: 1, maxTokens: 1, maxCostMicros: 1, maxVariants: 1, deadlineSeconds: 1 },
          skillVersionIds: [],
          findings: 0,
        };
      },
      async reserveBudget() {
        record('reserveBudget');
        return { reservationId: 'br_1', reservedMicros: 1 };
      },
      async planNextStep(_input, hooks) {
        hooks?.heartbeat('from-runtime');
        record('planNextStep', hooks !== undefined);
        return { kind: 'done', stepId: 'step_1', reason: 'end_turn' };
      },
      async dispatchTool() {
        record('dispatchTool');
        return { kind: 'ok', output: {} };
      },
      async recordDecision() {
        record('recordDecision');
      },
      async finishRun(input) {
        record('finishRun');
        return { runId: input.runId, state: input.state, costMicros: 0 };
      },
      async settleBudget() {
        record('settleBudget');
      },
    };
  };
  const input = (sp = spActive, tenantId = tenantA): AgentRunWorkflowInputV1 => ({
    tenantId,
    actor: { kind: 'service_principal', id: sp },
    correlationId: 'corr_act',
    runId: 'run_1',
    brandId: brandA,
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: 'act-agents-' + tenantA.slice(-6).toLowerCase() });
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A1',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await tdb.db.insert(servicePrincipals).values([
      {
        id: spActive,
        tenantId: tenantA,
        kind: 'agent',
        name: 'active',
        grants: [{ action: 'brand.read', brandIds: 'all' }],
        maxAutonomy: 'create',
        status: 'active',
        createdByUserId: 'usr_x',
      },
      {
        id: spRevoked,
        tenantId: tenantA,
        kind: 'agent',
        name: 'revoked',
        grants: [{ action: 'brand.read', brandIds: 'all' }],
        maxAutonomy: 'create',
        status: 'revoked',
        createdByUserId: 'usr_x',
      },
      {
        id: spRestricted,
        tenantId: tenantA,
        kind: 'agent',
        name: 'restricted',
        grants: [{ action: 'brand.read', brandIds: [brandA] }],
        maxAutonomy: 'create',
        status: 'active',
        createdByUserId: 'usr_x',
      },
    ]);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('establishes tenant context with the principal grants re-loaded now, and heartbeats the model call', async () => {
    const acts = createAgentRunActivities(fakeRuntime());
    const heartbeats: unknown[] = [];
    env.on('heartbeat', (d) => heartbeats.push(d));
    await run(acts.resolveContextSnapshot, input());
    await run(acts.reserveBudget, {
      ...input(),
      budget: { maxSteps: 1, maxTokens: 1, maxCostMicros: 1, maxVariants: 1, deadlineSeconds: 1 },
    });
    expect(await run(acts.planNextStep, { ...input(), step: 0 })).toEqual({
      kind: 'done',
      stepId: 'step_1',
      reason: 'end_turn',
    });
    await run(acts.dispatchTool, {
      ...input(),
      step: 0,
      stepId: 'step_1',
      call: { id: 't', name: 'facts.list', arguments: {} },
    });
    await run(acts.recordDecision, { ...input(), decision: { stepId: 'step_1', decision: 'accept' } });
    expect(await run(acts.finishRun, { ...input(), state: 'completed' })).toEqual({
      runId: 'run_1',
      state: 'completed',
      costMicros: 0,
    });
    await run(acts.settleBudget, input());
    expect(seen.map((s) => s.method)).toEqual([
      'resolveContextSnapshot',
      'reserveBudget',
      'planNextStep',
      'dispatchTool',
      'recordDecision',
      'finishRun',
      'settleBudget',
    ]);
    expect(seen.every((s) => s.tenantId === tenantA && s.brandIds === 'all')).toBe(true);
    expect(seen.find((s) => s.method === 'planNextStep')?.hooks).toBe(true);
    expect(heartbeats).toEqual(['plan:0', 'from-runtime']);
    seen.length = 0;
    const restricted = await run(createAgentRunActivities(fakeRuntime()).settleBudget, input(spRestricted));
    expect(restricted).toBeUndefined();
    expect(seen[0]?.brandIds).toEqual(new Set([brandA])); // grants as they are now, not as captured at start
  });

  it('a revoked principal or a foreign tenant fails as a non-retryable PolicyDenied before the runtime runs', async () => {
    seen.length = 0;
    const acts = createAgentRunActivities(fakeRuntime());
    const revoked = await run(acts.resolveContextSnapshot, input(spRevoked)).catch((e: unknown) => e);
    expect(revoked).toBeInstanceOf(ApplicationFailure);
    expect((revoked as ApplicationFailure).type).toBe('PolicyDenied');
    expect((revoked as ApplicationFailure).nonRetryable).toBe(true);
    const foreign = await run(acts.resolveContextSnapshot, input(spActive, newId('tenant'))).catch(
      (e: unknown) => e,
    );
    expect((foreign as ApplicationFailure).type).toBe('PolicyDenied');
    expect(seen).toEqual([]);
  });

  it.each([
    [new PolicyDeniedError('grant_missing'), 'PolicyDenied'],
    [new NotFoundError('AgentRun', 'run_x'), 'PolicyDenied'],
    [new BudgetExhaustedError('brand_day'), 'BudgetExhausted'],
    [new ValidationFailedError([{ issue: 'x' }]), 'ValidationFailed'],
    [new StaleRevisionError('rev_x'), 'ValidationFailed'],
  ] as const)('maps %s to non-retryable type %s (matched by type, not class name)', async (error, type) => {
    const acts = createAgentRunActivities(
      fakeRuntime(() => {
        throw error;
      }),
    );
    const failure = await run(acts.finishRun, { ...input(), state: 'completed' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).type).toBe(type);
    expect((failure as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('anything else propagates unchanged so Temporal retries it', async () => {
    const acts = createAgentRunActivities(
      fakeRuntime(() => {
        throw new Error('connection reset');
      }),
    );
    await expect(
      run(acts.dispatchTool, {
        ...input(),
        step: 0,
        stepId: 's',
        call: { id: 't', name: 'x', arguments: {} },
      }),
    ).rejects.toThrow('connection reset');
    expect(toActivityFailure(new Error('plain'))).toBeInstanceOf(Error);
    expect((toActivityFailure(new Error('plain')) as Error).message).toBe('plain');
  });
});
