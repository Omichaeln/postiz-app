import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { ErrorEnvelope } from '@oremedia/contracts/errors';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import {
  CROSS_TENANT_INPUTS,
  CSRF_TOKEN,
  callPath,
  callRest,
  restRoute,
  seedApiClient,
  seedTwoTenants,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src';
import { restRequestFor } from './rest/route';
import { allRestRoutes } from './rest/router';
import { createServer } from './server';
import { configureRateLimiter } from './trpc';

/**
 * Spec 7.6 public REST (ledger T.3): API client keys with enforced per-key scopes, each route the same procedure as
 * tRPC (same command, same tenant resolution, rate limit, idempotency and audit), the spec 7.2 envelope with the
 * matching HTTP status, pagination bounds clamped.
 */
describe('public REST API /v1 (spec 7.6)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    server = createServer().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await tdb?.drop();
  });

  const owner = () => ({ bearer: tenantA.ownerToken, tenantId: tenantA.tenantId });

  async function http(
    method: 'GET' | 'POST',
    url: string,
    opts: {
      bearer?: string;
      tenantId?: string;
      body?: unknown;
      key?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        ...(opts.tenantId ? { 'x-oremedia-tenant': opts.tenantId } : {}),
        ...(opts.key ? { 'idempotency-key': opts.key } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined
        ? { body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body) }
        : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  describe('route table', () => {
    it('covers the spec 7.6 resources, every mutation is a POST with an Idempotency-Key, every route is scoped', () => {
      const procedures = allRestRoutes().map((r) => r.procedure);
      for (const p of [
        'brand.list',
        'brand.get',
        'assets.search',
        'assets.get',
        'content.campaigns.list',
        'content.campaigns.get',
        'content.campaigns.create',
        'content.briefs.list',
        'content.briefs.get',
        'content.briefs.create',
        'content.packages.list',
        'content.packages.get',
        'content.packages.create',
        'review.requests.get',
        'review.requests.create',
        'publishing.publications.schedule',
        'publishing.publications.cancel',
        'publishing.publications.reschedule',
        'publishing.publications.get',
        'publishing.publications.list',
        'publishing.channels.list',
        'agents.runs.start',
        'agents.runs.get',
        'agents.runs.steps',
        'intelligence.insights.list',
        'intelligence.recommendations.list',
      ])
        expect(procedures, p).toContain(p);
      for (const r of allRestRoutes()) {
        if (r.type === 'mutation') expect(r.method).toBe('POST');
        expect(r.scope).toMatch(r.type === 'mutation' ? /:write$/ : /:read$/);
      }
    });

    it('every read route returns exactly what its tRPC procedure returns for the same input (same command)', async () => {
      for (const route of allRestRoutes().filter((r) => r.type === 'query')) {
        const input = CROSS_TENANT_INPUTS[route.procedure]?.buildInput?.(tenantA.ids);
        const viaTrpc = await callPath(owner(), route.procedure, input);
        const req = restRequestFor(route, input);
        const viaRest =
          route.method === 'GET'
            ? await http('GET', req.url, owner())
            : await http('POST', req.url, { ...owner(), body: req.body });
        if (viaTrpc.error) {
          expect(viaRest.status, route.path).toBeGreaterThanOrEqual(400);
          expect((viaRest.body as ErrorEnvelope).code, route.path).toBe(viaTrpc.error.code);
        } else {
          expect(viaRest.status, route.path).toBe(200);
          expect(viaRest.body, route.path).toEqual(JSON.parse(JSON.stringify(viaTrpc.data)));
        }
      }
    });
  });

  describe('HTTP behaviour', () => {
    it('reads the brand, lists campaigns and echoes the correlation id', async () => {
      const list = await http('GET', '/v1/brands', { ...owner(), headers: { 'x-correlation-id': 'rest-1' } });
      expect(list.status).toBe(200);
      expect(list.headers.get('x-correlation-id')).toBe('rest-1');
      expect((list.body as Array<{ id: string }>).map((b) => b.id).sort()).toEqual(
        [...tenantA.brandIds].sort(),
      );
      const one = await http('GET', `/v1/brands/${tenantA.brandIds[0]}`, owner());
      expect(one.body).toMatchObject({ id: tenantA.brandIds[0] });
    });

    it('creates with 201 and replays on the same Idempotency-Key; a different body is IDEMPOTENCY_KEY_REUSED', async () => {
      const key = randomUUID();
      const body = {
        brandId: tenantA.brandIds[0],
        name: 'REST campaign',
        startsAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2026-11-01T00:00:00.000Z',
      };
      const first = await http('POST', '/v1/campaigns', { ...owner(), key, body });
      expect(first.status).toBe(201);
      const replay = await http('POST', '/v1/campaigns', { ...owner(), key, body });
      expect(replay.status).toBe(201);
      expect(replay.body).toEqual(first.body);
      // The key belongs to (tenant, principal): the same command through tRPC with the same key replays too.
      const viaTrpc = await callPath({ ...owner(), idempotencyKey: key }, 'content.campaigns.create', body);
      expect(viaTrpc.data).toEqual(first.body);
      const reused = await http('POST', '/v1/campaigns', {
        ...owner(),
        key,
        body: { ...body, name: 'Other' },
      });
      expect(reused.status).toBe(409);
      expect((reused.body as ErrorEnvelope).code).toBe('IDEMPOTENCY_KEY_REUSED');
      const noKey = await http('POST', '/v1/campaigns', { ...owner(), body });
      expect(noKey.status).toBe(400);
      expect(noKey.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'Idempotency-Key', issue: 'required' }],
      });
      const campaigns = (
        await callPath(owner(), 'content.campaigns.list', {
          brandId: tenantA.brandIds[0],
          page: { limit: 200 },
        })
      ).data as { items: Array<{ name: string }> };
      expect(campaigns.items.filter((c) => c.name === 'REST campaign')).toHaveLength(1);
    });

    it('clamps pagination into [1, 200] instead of rejecting it; the cursor pages on', async () => {
      for (const name of ['Page one', 'Page two'])
        await callPath(owner(), 'content.campaigns.create', {
          brandId: tenantA.brandIds[1],
          name,
          startsAt: '2026-10-01T00:00:00.000Z',
          endsAt: '2026-11-01T00:00:00.000Z',
        });
      const url = `/v1/brands/${tenantA.brandIds[1]}/campaigns`;
      const huge = await http('GET', `${url}?limit=5000`, owner());
      expect(huge.status).toBe(200);
      expect((huge.body as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(2);
      const zero = await http('GET', `${url}?limit=0`, owner());
      const page1 = zero.body as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(page1.items).toHaveLength(1);
      expect(page1.nextCursor).toBeTruthy();
      const page2 = (
        await http('GET', `${url}?limit=1&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`, owner())
      ).body as { items: Array<{ id: string }> };
      expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
      const junk = await http('GET', `${url}?limit=abc`, owner());
      expect((junk.body as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(2);
      // tRPC validates rather than clamps (its client builds the request); both stay within the spec 7.4 bounds.
      const trpc = await callPath(owner(), 'content.campaigns.list', {
        brandId: tenantA.brandIds[1],
        page: { limit: 5000 },
      });
      expect(trpc.error?.code).toBe('VALIDATION_FAILED');
    });

    it('scheduling is the approval-bound publications.schedule command: no approval, no publication', async () => {
      const before = await tenantA.snapshot();
      const body = {
        channelVariantId: tenantA.ids['channelVariantId'],
        scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
        authority: 'approval',
      };
      const rest = await http('POST', '/v1/publications', { ...owner(), key: randomUUID(), body });
      const trpc = await callPath(owner(), 'publishing.publications.schedule', body);
      expect(rest.status).toBeGreaterThanOrEqual(400);
      expect(rest.status).toBeLessThan(500);
      expect((rest.body as ErrorEnvelope).code).toBe(trpc.error?.code);
      const counts = (s: string) =>
        (JSON.parse(s) as { counts: Record<string, number> }).counts['publications'];
      expect(counts(await tenantA.snapshot())).toBe(counts(before));
    });

    it('a malformed body is VALIDATION_FAILED, an unknown route NOT_FOUND, a cookie session is not accepted', async () => {
      const malformed = await http('POST', '/v1/campaigns', { ...owner(), key: randomUUID(), body: '{"x":' });
      expect(malformed.status).toBe(400);
      expect((malformed.body as ErrorEnvelope).code).toBe('VALIDATION_FAILED');
      const missing = await http('GET', '/v1/nothing-here', owner());
      expect(missing.status).toBe(404);
      expect((missing.body as ErrorEnvelope).code).toBe('NOT_FOUND');
      const cookie = await http('GET', '/v1/brands', {
        tenantId: tenantA.tenantId,
        headers: { cookie: `oremedia_session=${tenantA.ownerToken}; oremedia_csrf=${CSRF_TOKEN}` },
      });
      expect(cookie.status).toBe(401);
      expect(cookie.headers.get('www-authenticate')).toBe('Bearer');
      expect((cookie.body as ErrorEnvelope).code).toBe('UNAUTHENTICATED');
    });

    it('a foreign id is NOT_FOUND (404) and a foreign tenant header FORBIDDEN (403)', async () => {
      const foreign = await http('GET', `/v1/brands/${tenantB.brandIds[0]}`, owner());
      expect(foreign.status).toBe(404);
      const header = await http('GET', '/v1/brands', {
        bearer: tenantA.ownerToken,
        tenantId: tenantB.tenantId,
      });
      expect(header.status).toBe(403);
    });
  });

  describe('API client keys and per-key scopes', () => {
    it('a key needs the route scope: FORBIDDEN (403) with the envelope, audited; its own scope works', async () => {
      const k = await seedApiClient(tdb.db, tenantA, {
        grants: [
          { action: 'brand.read', brandIds: 'all' },
          { action: 'content.plan', brandIds: 'all' },
        ],
        scopes: ['brands:read'],
      });
      const ok = await http('GET', '/v1/brands', { bearer: k.key });
      expect(ok.status).toBe(200);
      const read = await http('GET', `/v1/brands/${tenantA.brandIds[0]}/campaigns`, { bearer: k.key });
      expect(read.status).toBe(403);
      expect(read.body).toMatchObject({
        code: 'FORBIDDEN',
        message: 'This API key does not have the content:read scope',
      });
      const write = await http('POST', '/v1/campaigns', {
        bearer: k.key,
        key: randomUUID(),
        body: {
          brandId: tenantA.brandIds[0],
          name: 'x',
          startsAt: '2026-10-01T00:00:00Z',
          endsAt: '2026-11-01T00:00:00Z',
        },
      });
      expect(write.status).toBe(403);
      expect((write.body as ErrorEnvelope).message).toMatch(/content:write/);
      const audit = (
        (
          await callPath(owner(), 'operations.audit.query', {
            query: { actorId: k.servicePrincipalId },
            page: { limit: 20 },
          })
        ).data as { items: Array<{ action: string; reason: string | null }> }
      ).items.filter((e) => e.action === 'api.scope');
      expect(audit.map((e) => e.reason)).toEqual(['scope_missing', 'scope_missing']);
    });

    it('a key with a write scope passes the scope check and reaches the policy engine', async () => {
      const k = await seedApiClient(tdb.db, tenantA, {
        grants: [{ action: 'brand.read', brandIds: 'all' }],
        scopes: ['content:write', 'content:read'],
      });
      const res = await callRest({ bearer: k.key }, restRoute('content.campaigns.create'), {
        brandId: tenantA.brandIds[0],
        name: 'x',
        startsAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2026-11-01T00:00:00.000Z',
      });
      expect(res.status).toBe(403); // the principal has no content.plan grant: the policy engine decides
      const audit = (
        (
          await callPath(owner(), 'operations.audit.query', {
            query: { actorId: k.servicePrincipalId },
            page: { limit: 20 },
          })
        ).data as { items: Array<{ action: string; reason: string | null }> }
      ).items;
      expect(audit.some((e) => e.action === 'api.scope')).toBe(false);
      expect(audit.some((e) => e.action === 'content.plan' && e.reason === 'brand_not_granted')).toBe(true);
    });

    it('a correctly scoped and granted key creates through REST at its effective autonomy (spec 12.5), never above the principal ceiling', async () => {
      const body = {
        brandId: tenantA.brandIds[0],
        name: 'Created by an API key',
        startsAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2026-11-01T00:00:00.000Z',
      };
      const writer = await seedApiClient(tdb.db, tenantA, {
        grants: [
          { action: 'brand.read', brandIds: 'all' },
          { action: 'content.plan', brandIds: 'all' },
        ],
        scopes: ['content:write', 'content:read'],
        maxAutonomy: 'create',
      });
      const created = await callRest({ bearer: writer.key }, restRoute('content.campaigns.create'), body);
      expect(created.status).toBe(201);
      // An assist-only principal with the same grant and scope is still refused: the ceiling is the principal's own.
      const assistOnly = await seedApiClient(tdb.db, tenantA, {
        grants: [
          { action: 'brand.read', brandIds: 'all' },
          { action: 'content.plan', brandIds: 'all' },
        ],
        scopes: ['content:write', 'content:read'],
        maxAutonomy: 'assist',
      });
      const refused = await callRest({ bearer: assistOnly.key }, restRoute('content.campaigns.create'), {
        ...body,
        name: 'Refused at assist',
      });
      expect(refused.status).toBe(403);
    });

    it('a key issued with no scopes keeps read access and loses write access (tRPC and REST alike)', async () => {
      const readList = await http('GET', `/v1/brands/${tenantA.brandIds[0]}/campaigns`, {
        bearer: tenantA.apiClientKey,
      });
      expect(readList.status).toBe(200);
      const body = {
        brandId: tenantA.brandIds[0],
        name: 'x',
        startsAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2026-11-01T00:00:00.000Z',
      };
      const rest = await http('POST', '/v1/campaigns', {
        bearer: tenantA.apiClientKey,
        key: randomUUID(),
        body,
      });
      const trpc = await callPath({ bearer: tenantA.apiClientKey }, 'content.campaigns.create', body);
      expect(rest.status).toBe(403);
      expect([(rest.body as ErrorEnvelope).message, trpc.error?.message]).toEqual([
        'This API key does not have the content:write scope',
        'This API key does not have the content:write scope',
      ]);
    });

    it('rate limiting answers 429 RATE_LIMITED with Retry-After', async () => {
      configureRateLimiter({
        multi: () => {
          const chain = {
            incr: () => chain,
            pttl: () => chain,
            exec: async () =>
              [
                [null, 1_000_000],
                [null, 2_500],
              ] as Array<[Error | null, unknown]>,
          };
          return chain;
        },
        pexpire: async () => 1,
      });
      try {
        const res = await http('GET', '/v1/brands', owner());
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('3');
        expect(res.body).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 2500 });
      } finally {
        configureRateLimiter();
      }
    });
  });
});
