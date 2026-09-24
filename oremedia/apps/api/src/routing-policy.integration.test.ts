import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ModelRoutingPolicy } from '@oremedia/contracts/agents';
import { modelRoutingPolicies } from '@oremedia/db/schema/agents';
import { auditEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { modelConfigFromEnv } from '@oremedia/ai';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src';
import { configureRateLimiter } from './trpc';

/**
 * Spec 12.7 through the tRPC surface: a tenant administrator stores the tenant's model-routing policy with
 * agents.routingPolicy.set, and the model route it forbids is refused for that tenant on the next run start
 * (agents.runs.start checks it before a run is created); another tenant is unaffected. A creator cannot change it,
 * and a stale version is a CONFLICT.
 */
describe('agents.routingPolicy through tRPC (spec 12.7)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  // The model agents.runs.start routes to (configuration, never a literal at a call site).
  const { model } = modelConfigFromEnv();
  const denyConfigured: ModelRoutingPolicy = {
    schemaVersion: 1,
    defaultModel: `${model}-alt`,
    permittedVendors: ['anthropic', 'fake'],
    permittedRegions: [],
    retention: 'zero',
    dataClasses: ['brand_content'],
    deniedModels: [model],
  };

  const owner = (t: SeededTenant) => ({ bearer: t.ownerToken, tenantId: t.tenantId });
  const startRun = (t: SeededTenant) =>
    callPath(owner(t), 'agents.runs.start', {
      brandId: t.brandIds[0],
      servicePrincipalId: t.servicePrincipalId,
      requestedAutonomy: 'create',
      taskKind: 'copywriting',
      brief: { objective: 'routing' },
    });
  const routingDenied = { code: 'FORBIDDEN', message: `Model ${model} is not permitted for this company` };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('an owner stores a policy and the model route it forbids is refused for that tenant only', async () => {
    const before = await startRun(tenantA);
    expect(before.error?.message).not.toBe(routingDenied.message);
    expect(await callPath(owner(tenantA), 'agents.routingPolicy.get', undefined)).toEqual({
      data: { policy: null, version: null, stored: false },
    });

    const set = await callPath(owner(tenantA), 'agents.routingPolicy.set', { policy: denyConfigured });
    expect(set).toEqual({ data: { policy: denyConfigured, version: 0 } });
    expect(await callPath(owner(tenantA), 'agents.routingPolicy.get', undefined)).toEqual({
      data: { policy: denyConfigured, version: 0, stored: true },
    });

    expect((await startRun(tenantA)).error).toMatchObject(routingDenied);
    // Tenant B has no stored policy: the platform policy applies and the route is not refused by routing.
    expect((await startRun(tenantB)).error?.message).not.toBe(routingDenied.message);

    const audits = await tdb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.tenantId, tenantA.tenantId), eq(auditEvents.action, 'agent.routing_policy.set')),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: tenantA.ownerUserId, resourceId: tenantA.tenantId });
  });

  it('a creator can neither read nor change the policy', async () => {
    const creator = { bearer: tenantB.creatorToken, tenantId: tenantB.tenantId };
    expect(
      (await callPath(creator, 'agents.routingPolicy.set', { policy: denyConfigured })).error,
    ).toMatchObject({ code: 'FORBIDDEN' });
    expect((await callPath(creator, 'agents.routingPolicy.get', undefined)).error).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      await tdb.db
        .select()
        .from(modelRoutingPolicies)
        .where(eq(modelRoutingPolicies.tenantId, tenantB.tenantId)),
    ).toEqual([]);
  });

  it('a change needs the current version: missing is VALIDATION_FAILED, stale is CONFLICT', async () => {
    const permit = { ...denyConfigured, deniedModels: [] };
    expect(
      (await callPath(owner(tenantA), 'agents.routingPolicy.set', { policy: permit })).error,
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      (await callPath(owner(tenantA), 'agents.routingPolicy.set', { policy: permit, expectedVersion: 5 }))
        .error,
    ).toMatchObject({ code: 'CONFLICT' });
    expect((await startRun(tenantA)).error).toMatchObject(routingDenied); // unchanged
    expect(
      await callPath(owner(tenantA), 'agents.routingPolicy.set', { policy: permit, expectedVersion: 0 }),
    ).toEqual({ data: { policy: permit, version: 1 } });
    expect((await startRun(tenantA)).error?.message).not.toBe(routingDenied.message);
  });
});
