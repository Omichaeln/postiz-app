import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_TOOLS, allProcedures, allRestRoutes } from '@oremedia/api';
import type { ErrorEnvelope } from '@oremedia/contracts/errors';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import {
  CROSS_TENANT_INPUTS,
  MCP_CROSS_TENANT_INPUTS,
  callMcpTool,
  callPath,
  callRest,
  seedApiClient,
  seedTwoTenants,
  type CrossTenantFixture,
  type SeededTenant,
} from './src';

/** Spec 19.3 expectation shared by tRPC and REST: no data, or NOT_FOUND / the fixture's code / VALIDATION_FAILED. */
function expectRejected(
  label: string,
  fixture: CrossTenantFixture,
  res: { data?: unknown; error?: ErrorEnvelope },
): void {
  if (fixture.expectEmpty && !res.error) {
    const data = res.data as { items?: unknown[] } | unknown[] | null;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    expect(items, `${label} returned data for foreign ids`).toEqual([]);
    return;
  }
  expect(res.error, `${label} returned data: ${JSON.stringify(res.data)}`).toBeDefined();
  expect([fixture.expectCode ?? 'NOT_FOUND', 'VALIDATION_FAILED']).toContain(res.error?.code);
}

/**
 * Spec 19.3: every tRPC procedure, every public REST route and every MCP tool is called as tenant A with tenant B's
 * ids (spec 18: "cross-tenant harness across tRPC, REST, MCP"). The outcome must be
 * NOT_FOUND (FORBIDDEN only where the fixture says the id is not secret) or VALIDATION_FAILED (or, for filter
 * queries, no data), and nothing may land in tenant B.
 */
describe('cross-tenant harness', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const procedures = allProcedures();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('every procedure has a cross-tenant fixture (a new endpoint without one fails CI)', () => {
    const missing = procedures.map((p) => p.path).filter((path) => !(path in CROSS_TENANT_INPUTS));
    expect(
      missing,
      `add fixtures in tooling/test-fixtures/src/cross-tenant-inputs.ts for: ${missing.join(', ')}`,
    ).toEqual([]);
    const stale = Object.keys(CROSS_TENANT_INPUTS).filter((path) => !procedures.some((q) => q.path === path));
    expect(stale, 'fixtures for procedures that no longer exist').toEqual([]);
  });

  it.each(allProcedures().map((p) => ({ path: p.path })))(
    '$path rejects foreign tenant resources',
    async ({ path }) => {
      const fixture = CROSS_TENANT_INPUTS[path];
      expect(fixture).toBeDefined();
      if (!fixture?.buildInput) return; // documented: takes no resource ids
      const before = await tenantB.snapshot();
      const input = fixture.buildInput(tenantB.ids); // every ID field points at tenant B
      const res = await callPath({ bearer: tenantA.ownerToken, tenantId: tenantA.tenantId }, path, input);
      // Spec 5.3: a foreign id is NOT_FOUND so existence is not leaked; a fixture opts into FORBIDDEN only
      // where the id is not secret. Input validation may reject the shape before any lookup.
      expectRejected(path, fixture, res);
      // Spec 7.2: the envelope's code is also the transport code (404/403/400), never INTERNAL_SERVER_ERROR.
      expect(res.trpcCode, `${path} surfaced ${res.error?.code} as ${res.trpcCode}`).not.toBe(
        'INTERNAL_SERVER_ERROR',
      );
      expect(await tenantB.snapshot()).toEqual(before); // no writes landed in tenant B
    },
  );

  // ---- Public REST (spec 7.6): generated from the REST route table; each route reuses its procedure's fixture. ----
  const restRoutes = allRestRoutes();

  it('every REST route serves a procedure that has a cross-tenant fixture (a new route without one fails CI)', () => {
    const missing = restRoutes
      .filter((r) => !(r.procedure in CROSS_TENANT_INPUTS))
      .map((r) => `${r.method} ${r.path} → ${r.procedure}`);
    expect(missing, `add fixtures in tooling/test-fixtures/src/inputs for: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it.each(restRoutes.map((r) => ({ method: r.method, path: r.path, procedure: r.procedure })))(
    'REST $method $path rejects foreign tenant resources',
    async ({ procedure }) => {
      const route = restRoutes.find((r) => r.procedure === procedure);
      const fixture = CROSS_TENANT_INPUTS[procedure];
      expect(route && fixture).toBeTruthy();
      if (!route || !fixture?.buildInput) return; // documented: takes no resource ids
      const before = await tenantB.snapshot();
      const res = await callRest(
        { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
        route,
        fixture.buildInput(tenantB.ids),
      );
      expectRejected(`${route.method} ${route.path}`, fixture, res);
      expect(res.status, `${route.path} answered ${res.status}`).toBeLessThan(500);
      expect(await tenantB.snapshot()).toEqual(before); // no writes landed in tenant B
    },
  );

  // ---- MCP (spec 7.6): generated from MCP_TOOLS; every call passes through the agent tool dispatcher. ----
  let cachedMcpKey: string | null = null;
  const mcpKey = async (): Promise<string> =>
    (cachedMcpKey ??= (
      await seedApiClient(tdb.db, tenantA, {
        grants: [
          'brand.read',
          'asset.read',
          'content.plan',
          'agent.start_run',
          'creative.edit',
          'review.request',
          'insight.read',
        ].map((action) => ({ action, brandIds: 'all' as const })),
        scopes: MCP_TOOLS.map((t) => t.scope),
        maxAutonomy: 'prepare_release',
      })
    ).key);

  it('every MCP tool has a cross-tenant fixture (a new tool without one fails CI)', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names.filter((n) => !(n in MCP_CROSS_TENANT_INPUTS))).toEqual([]);
    expect(Object.keys(MCP_CROSS_TENANT_INPUTS).filter((n) => !names.includes(n))).toEqual([]);
  });

  it.each(MCP_TOOLS.map((t) => ({ name: t.name })))(
    'MCP $name rejects foreign tenant resources',
    async ({ name }) => {
      const fixture = MCP_CROSS_TENANT_INPUTS[name];
      expect(fixture).toBeDefined();
      if (!fixture?.buildArguments) return; // documented: takes no ids
      const key = await mcpKey();
      const before = await tenantB.snapshot();
      const res = await callMcpTool({ bearer: key }, name, fixture.buildArguments(tenantB.ids, tenantA.ids));
      expect(res.error, `${name} returned data: ${JSON.stringify(res.data)}`).toBeDefined();
      // A Release 1 tool whose module has not landed yet is denied before it reads anything.
      const pending = res.error?.details?.some((d) => d.issue === 'tool_not_available_yet');
      expect(pending ? ['FORBIDDEN'] : ['NOT_FOUND', 'VALIDATION_FAILED']).toContain(res.error?.code);
      expect(await tenantB.snapshot()).toEqual(before);
    },
  );

  it.each(MCP_TOOLS.filter((t) => t.brandScoped).map((t) => ({ name: t.name })))(
    'MCP $name acting in a foreign brand is NOT_FOUND before any tool runs',
    async ({ name }) => {
      const key = await mcpKey();
      const before = await tenantB.snapshot();
      const args = MCP_CROSS_TENANT_INPUTS[name]?.buildArguments?.(tenantB.ids, tenantA.ids) ?? {};
      const res = await callMcpTool({ bearer: key }, name, { ...args, brandId: tenantB.brandIds[0] });
      expect(res.error?.code).toBe('NOT_FOUND');
      expect(await tenantB.snapshot()).toEqual(before);
    },
  );

  it('MCP brands.list lists only the caller tenant brands', async () => {
    const res = await callMcpTool({ bearer: await mcpKey() }, 'brands.list', {});
    const ids = (res.data?.['items'] as Array<{ id: string }>).map((b) => b.id).sort();
    expect(ids).toEqual([...tenantA.brandIds].sort());
  });

  it('a creator restricted to brand 1 cannot see brand 2 of the same tenant', async () => {
    const own = await callPath({ bearer: tenantA.creatorToken, tenantId: tenantA.tenantId }, 'brand.get', {
      brandId: tenantA.brandIds[0],
    });
    expect(own.error).toBeUndefined();
    const other = await callPath({ bearer: tenantA.creatorToken, tenantId: tenantA.tenantId }, 'brand.get', {
      brandId: tenantA.brandIds[1],
    });
    expect(other.error?.code).toBe('NOT_FOUND');
    const list = await callPath(
      { bearer: tenantA.creatorToken, tenantId: tenantA.tenantId },
      'brand.list',
      undefined,
    );
    expect((list.data as Array<{ id: string }>).map((b) => b.id)).toEqual([tenantA.brandIds[0]]);
  });

  it('an API client of tenant B cannot select tenant A', async () => {
    const res = await callPath(
      { bearer: tenantB.apiClientKey, tenantId: tenantA.tenantId },
      'brand.list',
      undefined,
    );
    expect(res.error?.code).toBe('FORBIDDEN');
    const ok = await callPath({ bearer: tenantB.apiClientKey }, 'brand.list', undefined);
    expect(ok.error).toBeUndefined();
    expect((ok.data as Array<{ id: string }>).length).toBe(2);
  });
});
