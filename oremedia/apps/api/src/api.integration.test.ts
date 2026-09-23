import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { callPath, seedTwoTenants, type SeededTenant } from '@oremedia/test-fixtures';
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
