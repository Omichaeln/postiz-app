import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflictError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { modelRoutingPolicies } from '@oremedia/db/schema/agents';
import { auditEvents } from '@oremedia/db/schema/operations';
import { assertRoutingAllowed, resetRoutingPolicies, type ModelRoutingPolicy } from '@oremedia/ai';
import { agentsService } from '@oremedia/module-agents';
import { composeModules } from './composition';

/**
 * Ledger 4.3 (spec 12.7) against MySQL with the worker-core composition: a tenant's model-routing policy is stored in
 * model_routing_policies, changed only by a tenant administrator (billing.manage) with an audit record, and read by
 * assertRoutingAllowed (the check before every model call) through the source the composition registers. A tenant
 * whose stored policy denies a model is refused; another tenant keeps the platform policy.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

const MODEL = 'claude-opus-5';
const denyOpus: ModelRoutingPolicy = {
  schemaVersion: 1,
  defaultModel: 'claude-sonnet-5',
  permittedVendors: ['anthropic'],
  permittedRegions: [],
  retention: 'zero',
  dataClasses: ['brand_content'],
  deniedModels: [MODEL],
};

describe('tenant model-routing policy is stored, audited and enforced (ledger 4.3)', () => {
  let tdb: TestDatabase;
  const tenantA = newId('ten');
  const tenantB = newId('ten');
  const actorIn = (tenantId: string, role: 'owner' | 'creator'): ResolvedActor => ({
    kind: 'user',
    id: `usr_${tenantId.slice(-12)}${role}`,
    tenantId,
    membershipId: `mem_${tenantId.slice(-12)}${role}`,
    membershipStatus: 'active',
    role,
    allBrands: true,
    brandGrants: [],
    mfaEnrolled: false,
  });
  const ctx = (tenantId: string, actor: ResolvedActor): TenantContext => ({
    tenantId,
    actor: { kind: actor.kind, id: actor.id },
    brandIds: 'all',
    correlationId: 'corr_routing',
  });
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>, role: 'owner' | 'creator' = 'owner') =>
    runInTenant(ctx(tenantId, actorIn(tenantId, role)), fn);
  const set = (tenantId: string, policy: ModelRoutingPolicy, expectedVersion?: number, role?: 'creator') =>
    inTenant(
      tenantId,
      () =>
        withTransaction((tx) =>
          agentsService.routingPolicy.set(
            actorIn(tenantId, role ?? 'owner'),
            { policy, ...(expectedVersion === undefined ? {} : { expectedVersion }) },
            tx,
          ),
        ),
      role,
    );
  const policyAudits = (tenantId: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, 'agent.routing_policy.set')));

  beforeAll(async () => {
    tdb = await createTestDatabase();
    for (const id of [tenantA, tenantB])
      await tdb.db.insert(tenants).values({ id, name: id, slug: `rp-${id.slice(-10).toLowerCase()}` });
  });
  afterEach(() => resetRoutingPolicies());
  afterAll(async () => {
    await tdb?.drop();
  });

  it('a stored policy that denies a model refuses that route for its tenant only; the change is audited', async () => {
    composeModules();
    await expect(
      inTenant(tenantA, () => assertRoutingAllowed(tenantA, 'anthropic', MODEL)),
    ).resolves.toBeDefined();
    expect(await set(tenantA, denyOpus)).toEqual({ policy: denyOpus, version: 0 });

    await expect(
      inTenant(tenantA, () => assertRoutingAllowed(tenantA, 'anthropic', MODEL)),
    ).rejects.toMatchObject({ reason: 'model_routing_denied' });
    await expect(
      inTenant(tenantA, () => assertRoutingAllowed(tenantA, 'anthropic', 'claude-sonnet-5')),
    ).resolves.toMatchObject({ retention: 'zero' });
    // Another tenant is unaffected: no stored row, the platform policy applies.
    await expect(
      inTenant(tenantB, () => assertRoutingAllowed(tenantB, 'anthropic', MODEL)),
    ).resolves.toMatchObject({
      deniedModels: [],
    });

    const audits = await policyAudits(tenantA);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorKind: 'user',
      actorId: actorIn(tenantA, 'owner').id,
      resourceType: 'tenant',
      resourceId: tenantA,
      decision: 'allowed',
    });
    expect(await policyAudits(tenantB)).toHaveLength(0);
    const rows = await tdb.db.select().from(modelRoutingPolicies);
    expect(rows.map((r) => r.tenantId)).toEqual([tenantA]);
  });

  it('changing the setting takes effect on the next check, needs the current version and is audited again', async () => {
    composeModules();
    await expect(set(tenantA, { ...denyOpus, deniedModels: [] })).rejects.toBeInstanceOf(
      ValidationFailedError,
    ); // no version
    await expect(set(tenantA, { ...denyOpus, deniedModels: [] }, 7)).rejects.toBeInstanceOf(ConflictError);
    expect(await set(tenantA, { ...denyOpus, deniedModels: [] }, 0)).toMatchObject({ version: 1 });
    await expect(
      inTenant(tenantA, () => assertRoutingAllowed(tenantA, 'anthropic', MODEL)),
    ).resolves.toBeDefined();
    const audits = await policyAudits(tenantA);
    expect(audits).toHaveLength(2);
    // Like brand.versions.update: the change records the version it replaced, never the document's contents.
    expect(audits.map((a) => a.metadata)).toEqual(expect.arrayContaining([null, { expectedVersion: 0 }]));
    expect(
      await inTenant(tenantA, () => agentsService.routingPolicy.get(actorIn(tenantA, 'owner'))),
    ).toMatchObject({
      stored: true,
      version: 1,
      policy: { deniedModels: [] },
    });
  });

  it('only a tenant administrator changes it, and the stored policy is never read for another tenant', async () => {
    composeModules();
    await expect(set(tenantB, denyOpus, undefined, 'creator')).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(
      await tdb.db.select().from(modelRoutingPolicies).where(eq(modelRoutingPolicies.tenantId, tenantB)),
    ).toEqual([]);
    // A check for tenant A from inside tenant B's context is refused, never answered with a default.
    await expect(
      inTenant(tenantB, () => assertRoutingAllowed(tenantA, 'anthropic', MODEL)),
    ).rejects.toMatchObject({
      reason: 'tenant_mismatch',
    });
  });
});
