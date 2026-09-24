import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allProcedures } from '@oremedia/api';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { CROSS_TENANT_INPUTS, callPath, seedTwoTenants, type SeededTenant } from './src';

/**
 * Spec 19.3: every tRPC procedure is called as tenant A's owner with tenant B's ids. The outcome must be
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
      if (fixture.expectEmpty && !res.error) {
        const data = res.data as { items?: unknown[] } | unknown[] | null;
        const items = Array.isArray(data) ? data : (data?.items ?? []);
        expect(items, `${path} returned data for foreign ids`).toEqual([]);
      } else {
        expect(res.error, `${path} returned data: ${JSON.stringify(res.data)}`).toBeDefined();
        // Spec 5.3: a foreign id is NOT_FOUND so existence is not leaked; a fixture opts into FORBIDDEN only
        // where the id is not secret. Input validation may reject the shape before any lookup.
        expect([fixture.expectCode ?? 'NOT_FOUND', 'VALIDATION_FAILED']).toContain(res.error?.code);
        // Spec 7.2: the envelope's code is also the transport code (404/403/400), never INTERNAL_SERVER_ERROR.
        expect(res.trpcCode, `${path} surfaced ${res.error?.code} as ${res.trpcCode}`).not.toBe(
          'INTERNAL_SERVER_ERROR',
        );
      }
      expect(await tenantB.snapshot()).toEqual(before); // no writes landed in tenant B
    },
  );

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
