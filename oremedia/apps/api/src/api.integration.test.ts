import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { CSRF_TOKEN, callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src';
import { createServer } from './server';
import { configureRateLimiter } from './trpc';

describe('API request path (spec 4.3, 7.1–7.3)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('unauthenticated calls get UNAUTHENTICATED in the envelope', async () => {
    const res = await callPath({ bearer: 'ses_nope', tenantId: tenantA.tenantId }, 'access.me', undefined);
    expect(res.error?.code).toBe('UNAUTHENTICATED');
    expect(res.error?.correlationId).toBeTruthy();
  });

  it('the tenant header is a selection verified against memberships', async () => {
    const res = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantB.tenantId },
      'access.me',
      undefined,
    );
    expect(res.error?.code).toBe('FORBIDDEN');
    const me = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'access.me',
      undefined,
    );
    expect((me.data as { tenantId: string }).tenantId).toBe(tenantA.tenantId);
  });

  it('mutations require an Idempotency-Key and replay on the same key', async () => {
    const key = randomUUID();
    const first = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId, idempotencyKey: key },
      'brand.create',
      { name: 'New brand', timezone: 'UTC', defaultLocale: 'en' },
    );
    expect(first.error).toBeUndefined();
    const second = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId, idempotencyKey: key },
      'brand.create',
      { name: 'New brand', timezone: 'UTC', defaultLocale: 'en' },
    );
    expect(second.data).toEqual(first.data);
    const reused = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId, idempotencyKey: key },
      'brand.create',
      { name: 'Other', timezone: 'UTC', defaultLocale: 'en' },
    );
    expect(reused.error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const list = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'brand.list',
      undefined,
    );
    expect((list.data as unknown[]).length).toBe(3);
  });

  it('validation failures return VALIDATION_FAILED with details, never internal state', async () => {
    const res = await callPath({ bearer: tenantA.ownerToken, tenantId: tenantA.tenantId }, 'brand.create', {
      name: '',
      timezone: 'UTC',
      defaultLocale: 'e',
    });
    expect(res.error?.code).toBe('VALIDATION_FAILED');
    expect(res.error?.details?.some((d: { path?: string }) => d.path === 'name')).toBe(true);
  });

  it('role checks are server-side: a creator cannot invite members; the denial is audited', async () => {
    const res = await callPath(
      { bearer: tenantA.creatorToken, tenantId: tenantA.tenantId },
      'access.members.invite',
      { email: 'x@example.test', role: 'creator' },
    );
    expect(res.error?.code).toBe('FORBIDDEN');
    // Spec 7.2: the domain error carries its own tRPC code (HTTP 403), never INTERNAL_SERVER_ERROR.
    expect(res.trpcCode).toBe('FORBIDDEN');
    const audit = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'operations.audit.query',
      { query: { actorId: tenantA.creatorUserId }, page: { limit: 10 } },
    );
    const items = (
      audit.data as { items: Array<{ action: string; decision: string; reason: string | null }> }
    ).items;
    expect(
      items.some(
        (i) => i.action === 'membership.manage' && i.decision === 'denied' && i.reason === 'role_missing',
      ),
    ).toBe(true);
  });

  it('service principals cannot be granted foreign brands and agents can never manage memberships', async () => {
    const bad = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'access.servicePrincipals.create',
      {
        kind: 'agent',
        name: 'a',
        grants: [{ action: 'creative.edit', brandIds: [tenantB.brandIds[0]] }],
        maxAutonomy: 'create',
      },
    );
    expect(bad.error?.code).toBe('VALIDATION_FAILED');
    const viaAgent = await callPath({ bearer: tenantA.apiClientKey }, 'access.members.invite', {
      email: 'y@example.test',
      role: 'creator',
    });
    expect(viaAgent.error?.code).toBe('FORBIDDEN');
  });

  it('API keys are returned once and hashed at rest; rotation revokes the old key', async () => {
    const created = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'access.apiClients.create',
      { servicePrincipalId: tenantA.servicePrincipalId, scopes: [] },
    );
    const { apiClientId, key } = created.data as { apiClientId: string; key: string };
    expect(key.startsWith('ak_')).toBe(true);
    expect((await callPath({ bearer: key }, 'brand.list', undefined)).error).toBeUndefined();
    const rotated = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'access.apiClients.rotate',
      { apiClientId },
    );
    expect((rotated.data as { key: string }).key).not.toBe(key);
    expect((await callPath({ bearer: key }, 'brand.list', undefined)).error?.code).toBe('UNAUTHENTICATED');
  });

  it('cookie sessions must present the CSRF double-submit token on every mutation (spec 18)', async () => {
    const noHeader = await callPath(
      { bearer: tenantA.ownerToken, cookieSession: {} },
      'access.switchCompany',
      { tenantId: tenantA.tenantId },
    );
    expect(noHeader.error?.code).toBe('FORBIDDEN');
    expect(noHeader.trpcCode).toBe('FORBIDDEN');
    const wrongHeader = await callPath(
      { bearer: tenantA.ownerToken, cookieSession: { csrf: 'not-the-cookie' } },
      'access.switchCompany',
      { tenantId: tenantA.tenantId },
    );
    expect(wrongHeader.error?.code).toBe('FORBIDDEN');
    const ok = await callPath(
      { bearer: tenantA.ownerToken, cookieSession: { csrf: CSRF_TOKEN } },
      'access.switchCompany',
      { tenantId: tenantA.tenantId },
    );
    expect(ok.error).toBeUndefined();
    expect(ok.data).toEqual({ tenantId: tenantA.tenantId });
    // The same guard sits in front of tenant mutations (the idempotency path), unchanged.
    const tenantMutation = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId, cookieSession: {} },
      'brand.create',
      { name: 'CSRF brand', timezone: 'UTC', defaultLocale: 'en' },
    );
    expect(tenantMutation.error?.code).toBe('FORBIDDEN');
    // Bearer callers are exempt: the token cannot be replayed cross-site.
    const query = await callPath({ bearer: tenantA.ownerToken }, 'access.listCompanies', undefined);
    expect(query.error).toBeUndefined();
  });

  it('a client-chosen correlation id is kept only when it is safe to log; otherwise one is minted', async () => {
    const kept = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId, correlationId: 'req_1.a:b-c' },
      'brand.get',
      { brandId: tenantB.brandIds[0] },
    );
    expect(kept.error?.correlationId).toBe('req_1.a:b-c');
    const minted = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId, correlationId: 'bad id\n{"x":1}' },
      'brand.get',
      { brandId: tenantB.brandIds[0] },
    );
    expect(minted.error?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a request outside tRPC gets a NOT_FOUND envelope with HTTP 404', async () => {
    const app = createServer();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/nope`, { headers: { 'x-correlation-id': 'c404' } });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        code: 'NOT_FOUND',
        message: 'Route not found',
        correlationId: 'c404',
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('rate limiting returns RATE_LIMITED with retry-after', async () => {
    let limited: unknown;
    for (let i = 0; i < 650 && !limited; i++) {
      const r = await callPath(
        { bearer: tenantB.ownerToken, tenantId: tenantB.tenantId, correlationId: 'rl' },
        'brand.list',
        undefined,
      );
      if (r.error?.code === 'RATE_LIMITED') limited = r.error;
    }
    expect(limited).toMatchObject({ code: 'RATE_LIMITED' });
    expect((limited as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });
});
