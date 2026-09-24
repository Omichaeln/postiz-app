import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import {
  callMcp,
  callMcpTool,
  callPath,
  callRest,
  restRoute,
  seedApiClient,
  seedTwoTenants,
  type SeededTenant,
} from '../../../tooling/test-fixtures/src';
import { createMcpRegistry, MCP_TOOLS } from './mcp/tools';
import { createServer } from './server';
import { configureRateLimiter } from './trpc';

/**
 * Spec 7.6 MCP server (ledger T.3): authenticated as a service principal by API key, the curated subset only, every
 * call through the agent tool dispatcher (policy, audit), no scheduling tool, and the same authorisation outcomes
 * as tRPC and REST for the same fixtures.
 */
describe('MCP server (spec 7.6, 12.4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let server: Server;
  let base: string;
  /** Every MCP action granted on every brand, every MCP scope. */
  let full: { key: string; servicePrincipalId: string; apiClientId: string };

  const ALL_ACTIONS = [
    'brand.read',
    'asset.read',
    'content.plan',
    'agent.start_run',
    'creative.edit',
    'review.request',
    'insight.read',
  ];

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    full = await seedApiClient(tdb.db, tenantA, {
      grants: ALL_ACTIONS.map((action) => ({ action, brandIds: 'all' as const })),
      scopes: MCP_TOOLS.map((t) => t.scope),
      maxAutonomy: 'prepare_release',
    });
    server = createServer().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await tdb?.drop();
  });

  const rpc = (key: string | null, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  /** Tenant A's rows except the audit trail (denials are audited by design; nothing else may be written). */
  const domainRows = async () => {
    const snap = JSON.parse(await tenantA.snapshot()) as { counts: Record<string, number> };
    delete snap.counts['audit_events'];
    return snap;
  };

  const auditFor = async (actorId: string) =>
    (
      (
        await callPath({ bearer: tenantA.ownerToken, tenantId: tenantA.tenantId }, 'operations.audit.query', {
          query: { actorId },
          page: { limit: 100 },
        })
      ).data as {
        items: Array<{ action: string; decision: string; reason: string | null; resourceId: string }>;
      }
    ).items;

  describe('protocol over Streamable HTTP', () => {
    it('initialize negotiates the protocol version and advertises tools only', async () => {
      const res = await rpc(full.key, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const body = (await res.json()) as { id: number; result: Record<string, unknown> };
      expect(body.id).toBe(1);
      expect(body.result).toMatchObject({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'oremedia' },
      });
      const older = (await (
        await rpc(full.key, {
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: { protocolVersion: '1999-01-01' },
        })
      ).json()) as { result: { protocolVersion: string } };
      expect(older.result.protocolVersion).toBe('2025-06-18');
    });

    it('notifications get 202 without a body; ping answers; GET is 405; batches and junk are rejected', async () => {
      const note = await rpc(full.key, { jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(note.status).toBe(202);
      expect(await note.text()).toBe('');
      const ping = (await (await rpc(full.key, { jsonrpc: '2.0', id: 'p', method: 'ping' })).json()) as {
        result: unknown;
      };
      expect(ping.result).toEqual({});
      const get = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${full.key}` } });
      expect(get.status).toBe(405);
      expect(get.headers.get('allow')).toBe('POST');
      const batch = (await (await rpc(full.key, [{ jsonrpc: '2.0', id: 1, method: 'ping' }])).json()) as {
        error: { code: number };
      };
      expect(batch.error.code).toBe(-32600);
      const parse = await rpc(full.key, '{not json');
      expect(parse.status).toBe(400);
      expect(((await parse.json()) as { error: { code: number } }).error.code).toBe(-32700);
      const unknown = await callMcp({ bearer: full.key }, 'resources/list');
      expect(unknown.rpcCode).toBe(-32601);
    });

    it('tools/list returns exactly the curated subset with the registry schemas; nothing schedules or publishes', async () => {
      const res = await callMcp({ bearer: full.key }, 'tools/list');
      const tools = (
        res.result as {
          tools: Array<{
            name: string;
            inputSchema: { properties: Record<string, unknown>; required?: string[] };
          }>;
        }
      ).tools;
      expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
      const registry = createMcpRegistry();
      for (const tool of tools) {
        const def = registry.get(tool.name);
        expect(def, tool.name).toBeDefined();
        const exposure = MCP_TOOLS.find((t) => t.name === tool.name);
        // The registry's own schema, plus the brand the call acts in for brand-scoped tools.
        const { brandId, ...properties } = tool.inputSchema.properties;
        expect(properties).toEqual((def?.inputSchema as { properties: Record<string, unknown> }).properties);
        expect(brandId !== undefined).toBe(exposure?.brandScoped);
        if (exposure?.brandScoped) expect(tool.inputSchema.required).toContain('brandId');
        expect(tool.name).not.toMatch(/schedul|publish|release|delete/i);
        expect(def?.action.startsWith('publication.')).toBe(false);
        expect(def?.effect).not.toBe('external');
      }
    });
  });

  describe('authentication', () => {
    it('requires an API client key: none, unknown or a user session is UNAUTHENTICATED (401 + envelope)', async () => {
      for (const key of [null, 'ak_unknown', tenantA.ownerToken]) {
        const res = await rpc(key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        const body = (await res.json()) as { error: { data: { code: string; correlationId: string } } };
        expect(body.error.data.code).toBe('UNAUTHENTICATED');
        expect(body.error.data.correlationId).toBeTruthy();
      }
    });

    it('a key cannot select another tenant', async () => {
      const res = await callMcp({ bearer: full.key, tenantId: tenantB.tenantId }, 'tools/list');
      expect(res.status).toBe(403);
      expect(res.error?.code).toBe('FORBIDDEN');
    });
  });

  describe('tools/call through the dispatcher', () => {
    it('brands.list returns the granted brands; a key granted brand 1 only sees brand 1', async () => {
      const all = await callMcpTool({ bearer: full.key }, 'brands.list', {});
      expect((all.data?.['items'] as Array<{ id: string }>).map((b) => b.id).sort()).toEqual(
        [...tenantA.brandIds].sort(),
      );
      const narrow = await seedApiClient(tdb.db, tenantA, {
        grants: [{ action: 'brand.read', brandIds: [tenantA.brandIds[0]] }],
        scopes: ['brands:read'],
      });
      const one = await callMcpTool({ bearer: narrow.key }, 'brands.list', {});
      expect((one.data?.['items'] as Array<{ id: string }>).map((b) => b.id)).toEqual([tenantA.brandIds[0]]);
    });

    it('assets.searchEligible and insights.list read the brand; publications.get reads publication state', async () => {
      const assets = await callMcpTool({ bearer: full.key }, 'assets.searchEligible', {
        brandId: tenantA.brandIds[0],
        purpose: 'creative',
      });
      expect(assets.error).toBeUndefined();
      expect(Array.isArray(assets.data?.['items'])).toBe(true);
      const insights = await callMcpTool({ bearer: full.key }, 'insights.list', {
        brandId: tenantA.brandIds[0],
      });
      expect(insights.error).toBeUndefined();
      expect(insights.data).toHaveProperty('nextCursor');
      const pub = await callMcpTool({ bearer: full.key }, 'publications.get', {
        brandId: tenantA.brandIds[0],
        publicationId: tenantA.ids['publicationId'],
      });
      expect(pub.error).toBeUndefined();
      expect(pub.data).toMatchObject({ id: tenantA.ids['publicationId'], brandId: tenantA.brandIds[0] });
      // The same publication read through another brand of the tenant is NOT_FOUND (the call's brand is binding).
      const otherBrand = await callMcpTool({ bearer: full.key }, 'publications.get', {
        brandId: tenantA.brandIds[1],
        publicationId: tenantA.ids['publicationId'],
      });
      expect(otherBrand.error?.code).toBe('NOT_FOUND');
    });

    it('invalid arguments are VALIDATION_FAILED (-32602) with details; a missing brandId too', async () => {
      const bad = await callMcp({ bearer: full.key }, 'tools/call', {
        name: 'assets.searchEligible',
        arguments: { brandId: tenantA.brandIds[0], limit: 5000, extra: true },
      });
      expect(bad.rpcCode).toBe(-32602);
      expect(bad.error?.code).toBe('VALIDATION_FAILED');
      expect(bad.error?.details?.length).toBeGreaterThan(0);
      const noBrand = await callMcpTool({ bearer: full.key }, 'insights.list', {});
      expect(noBrand.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'brandId' }] });
    });

    it('a tool outside the subset is denied as tool_not_allowed and audited, whatever the key may do', async () => {
      const before = await domainRows();
      for (const name of [
        'images.generate',
        'publications.proposeSchedule',
        'content.draftCopy',
        'shell.exec',
      ]) {
        const res = await callMcpTool({ bearer: full.key }, name, { brandId: tenantA.brandIds[0] });
        expect(res.error?.code, name).toBe('FORBIDDEN');
        expect(res.error?.details).toEqual([{ issue: 'tool_not_allowed' }]);
      }
      const denials = (await auditFor(full.servicePrincipalId)).filter(
        (e) => e.action === 'agent.tool.denied' && e.decision === 'denied' && e.reason === 'tool_not_allowed',
      );
      expect(denials.length).toBeGreaterThanOrEqual(4);
      expect(denials.every((e) => e.resourceId.startsWith('mcp_'))).toBe(true);
      expect(await domainRows()).toEqual(before);
    });

    it('no MCP tool can schedule: scheduling names are unknown or denied and no publication is written', async () => {
      const before = await domainRows();
      for (const name of [
        'publishing.publications.schedule',
        'publications.schedule',
        'publications.proposeSchedule',
      ]) {
        const res = await callMcpTool({ bearer: full.key }, name, {
          brandId: tenantA.brandIds[0],
          channelVariantId: tenantA.ids['channelVariantId'],
          scheduledFor: '2030-01-01T00:00:00.000Z',
          authority: 'approval',
        });
        expect(res.error?.code, name).toBe('FORBIDDEN');
      }
      expect(MCP_TOOLS.some((t) => /schedul|publish/i.test(t.name))).toBe(false);
      expect(await domainRows()).toEqual(before);
    });

    it('the policy engine decides each call as for an agent: a missing grant is denied and audited', async () => {
      const noInsights = await seedApiClient(tdb.db, tenantA, {
        grants: [{ action: 'brand.read', brandIds: 'all' }],
        scopes: ['brands:read', 'insights:read'],
      });
      const res = await callMcpTool({ bearer: noInsights.key }, 'insights.list', {
        brandId: tenantA.brandIds[0],
      });
      expect(res.error?.code).toBe('FORBIDDEN');
      const denied = (await auditFor(noInsights.servicePrincipalId)).find(
        (e) => e.action === 'agent.tool.insights.list' && e.decision === 'denied',
      );
      expect(denied?.reason).toBe('brand_not_granted');
    });

    it('allowed calls are audited as agent tool invocations of the service principal', async () => {
      await callMcpTool({ bearer: full.key }, 'insights.list', { brandId: tenantA.brandIds[1] });
      const allowed = (await auditFor(full.servicePrincipalId)).find(
        (e) => e.action === 'agent.tool.insights.list' && e.decision === 'allowed',
      );
      expect(allowed?.resourceId).toMatch(/^mcp_/);
    });
  });

  describe('identical authorisation across tRPC, REST and MCP (ledger T.3)', () => {
    it('a principal restricted to brand 1 gets NOT_FOUND on brand 2 through all three', async () => {
      const narrow = await seedApiClient(tdb.db, tenantA, {
        grants: ALL_ACTIONS.map((action) => ({ action, brandIds: [tenantA.brandIds[0]] })),
        scopes: MCP_TOOLS.map((t) => t.scope),
      });
      const opts = { bearer: narrow.key };
      const input = { brandId: tenantA.brandIds[1] };
      const trpc = await callPath(opts, 'brand.get', input);
      const rest = await callRest(opts, restRoute('brand.get'), input);
      const mcp = await callMcpTool(opts, 'insights.list', input);
      expect([trpc.error?.code, rest.error?.code, mcp.error?.code]).toEqual([
        'NOT_FOUND',
        'NOT_FOUND',
        'NOT_FOUND',
      ]);
      expect(rest.status).toBe(404);
      // And the creator session restricted to brand 1, on the surfaces a session may use.
      const creator = { bearer: tenantA.creatorToken, tenantId: tenantA.tenantId };
      expect((await callPath(creator, 'brand.get', input)).error?.code).toBe('NOT_FOUND');
      expect((await callRest(creator, restRoute('brand.get'), input)).error?.code).toBe('NOT_FOUND');
      expect((await callMcp(creator, 'tools/list')).error?.code).toBe('UNAUTHENTICATED'); // MCP is key-only
    });

    it('a revoked key is UNAUTHENTICATED on all three', async () => {
      const k = await seedApiClient(tdb.db, tenantA, {
        grants: [{ action: 'brand.read', brandIds: 'all' }],
        scopes: ['brands:read'],
      });
      expect((await callPath({ bearer: k.key }, 'brand.list', undefined)).error).toBeUndefined();
      const rotated = await callPath(
        { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
        'access.apiClients.rotate',
        { apiClientId: k.apiClientId },
      );
      expect(rotated.error).toBeUndefined();
      const trpc = await callPath({ bearer: k.key }, 'brand.list', undefined);
      const rest = await callRest({ bearer: k.key }, restRoute('brand.list'), undefined);
      const mcp = await callMcp({ bearer: k.key }, 'tools/call', { name: 'brands.list', arguments: {} });
      expect([trpc.error?.code, rest.error?.code, mcp.error?.code]).toEqual([
        'UNAUTHENTICATED',
        'UNAUTHENTICATED',
        'UNAUTHENTICATED',
      ]);
      expect([rest.status, mcp.status]).toEqual([401, 401]);
      // The principal revoked (every key of it): the same on all three.
      const sp = await seedApiClient(tdb.db, tenantA, {
        grants: [{ action: 'brand.read', brandIds: 'all' }],
        scopes: ['brands:read'],
      });
      await callPath(
        { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
        'access.servicePrincipals.revoke',
        {
          servicePrincipalId: sp.servicePrincipalId,
          expectedVersion: 0,
        },
      );
      const codes = [
        (await callPath({ bearer: sp.key }, 'brand.list', undefined)).error?.code,
        (await callRest({ bearer: sp.key }, restRoute('brand.list'), undefined)).error?.code,
        (await callMcp({ bearer: sp.key }, 'tools/list')).error?.code,
      ];
      expect(codes).toEqual(['UNAUTHENTICATED', 'UNAUTHENTICATED', 'UNAUTHENTICATED']);
    });

    it('a missing scope is FORBIDDEN with the envelope on all three, and audited', async () => {
      const readOnly = await seedApiClient(tdb.db, tenantA, {
        grants: ALL_ACTIONS.map((action) => ({ action, brandIds: 'all' as const })),
        scopes: ['brands:read'],
      });
      const opts = { bearer: readOnly.key };
      const trpc = await callPath(opts, 'intelligence.insights.list', {
        brandId: tenantA.brandIds[0],
        page: { limit: 5 },
      });
      const rest = await callRest(opts, restRoute('intelligence.insights.list'), {
        brandId: tenantA.brandIds[0],
        page: { limit: 5 },
      });
      const mcp = await callMcpTool(opts, 'insights.list', { brandId: tenantA.brandIds[0] });
      expect([trpc.error?.code, rest.error?.code, mcp.error?.code]).toEqual([
        'FORBIDDEN',
        'FORBIDDEN',
        'FORBIDDEN',
      ]);
      expect(rest.status).toBe(403);
      expect(rest.error).toMatchObject({ message: 'This API key does not have the insights:read scope' });
      expect(mcp.error?.message).toBe('This API key does not have the insights:read scope');
      const denials = (await auditFor(readOnly.servicePrincipalId)).filter(
        (e) => e.action === 'api.scope' && e.reason === 'scope_missing',
      );
      expect(denials.length).toBe(3);
      // The scope it has works everywhere.
      expect((await callMcpTool(opts, 'brands.list', {})).error).toBeUndefined();
      expect((await callRest(opts, restRoute('brand.list'), undefined)).status).toBe(200);
    });

    it('a key with no scopes keeps read access only (keys issued before enforcement)', async () => {
      const legacy = await seedApiClient(tdb.db, tenantA, {
        grants: ALL_ACTIONS.map((action) => ({ action, brandIds: 'all' as const })),
        scopes: [],
      });
      const opts = { bearer: legacy.key };
      expect(
        (await callMcpTool(opts, 'insights.list', { brandId: tenantA.brandIds[0] })).error,
      ).toBeUndefined();
      const write = await callMcpTool(opts, 'agents.startRun', {
        brandId: tenantA.brandIds[0],
        taskKind: 'copywriting',
        brief: { objective: 'x' },
      });
      expect(write.error?.code).toBe('FORBIDDEN');
      expect(write.error?.message).toMatch(/agents:write/);
    });

    it('the MCP rate limit answers 429 RATE_LIMITED with Retry-After, like REST and tRPC', async () => {
      configureRateLimiter({
        multi: () => {
          const chain = {
            incr: () => chain,
            pttl: () => chain,
            exec: async () =>
              [
                [null, 1_000_000],
                [null, 4_000],
              ] as Array<[Error | null, unknown]>,
          };
          return chain;
        },
        pexpire: async () => 1,
      });
      try {
        const res = await rpc(full.key, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        expect(res.status).toBe(429);
        expect(res.headers.get('retry-after')).toBe('4');
        const body = (await res.json()) as { error: { data: { code: string; retryAfterMs: number } } };
        expect(body.error.data).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 4000 });
        const trpc = await callPath({ bearer: full.key }, 'brand.list', undefined);
        const rest = await callRest({ bearer: full.key }, restRoute('brand.list'), undefined);
        expect([trpc.error?.code, rest.error?.code]).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
        expect(rest.status).toBe(429);
        expect(rest.headers['retry-after']).toBe('4');
      } finally {
        configureRateLimiter();
      }
    });
  });
});
