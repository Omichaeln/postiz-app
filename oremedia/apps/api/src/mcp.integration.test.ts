import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { defaultPolicyDocument } from '@oremedia/contracts/brand';
import { agentRuns } from '@oremedia/db/schema/agents';
import { brands } from '@oremedia/db/schema/brand';
import { briefs } from '@oremedia/db/schema/content';
import { idempotencyKeys, outboxEvents } from '@oremedia/db/schema/operations';
import { reviewRequests } from '@oremedia/db/schema/review';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { hashRequest } from '@oremedia/module-operations';
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
import { seedContentPackage } from '../../../tooling/test-fixtures/src/inputs/content-seed';
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

  describe('write tools succeed for a correctly scoped and granted key (ledger T.3)', () => {
    const outboxFor = async (aggregateId: string) =>
      tdb.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA.tenantId), eq(outboxEvents.aggregateId, aggregateId)));

    it('agents.startRun starts a run at the key’s effective autonomy (spec 12.5): run row, audit and outbox event', async () => {
      const writer = await seedApiClient(tdb.db, tenantA, {
        grants: [
          { action: 'brand.read', brandIds: 'all' },
          { action: 'agent.start_run', brandIds: 'all' },
        ],
        scopes: ['agents:write'],
        maxAutonomy: 'create',
      });
      const before = await domainRows();
      const res = await callMcpTool({ bearer: writer.key }, 'agents.startRun', {
        brandId: tenantA.brandIds[0],
        taskKind: 'copywriting',
        brief: { objective: 'Launch post' },
        requestedAutonomy: 'prepare_release', // above the principal ceiling: the run is capped at create
      });
      expect(res.error).toBeUndefined();
      const runId = res.data?.['runId'] as string;
      expect(runId).toMatch(/^run_/);
      expect(res.data).toMatchObject({ state: 'planned', autonomyMode: 'create' });
      const [run] = await tdb.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.tenantId, tenantA.tenantId), eq(agentRuns.id, runId)));
      expect(run).toMatchObject({
        brandId: tenantA.brandIds[0],
        servicePrincipalId: writer.servicePrincipalId,
        initiatorId: writer.servicePrincipalId,
        autonomyMode: 'create',
        taskKind: 'copywriting',
        state: 'planned',
      });
      const trail = await auditFor(writer.servicePrincipalId);
      expect(trail.find((e) => e.action === 'agent.tool.agents.startRun')?.decision).toBe('allowed');
      expect(trail.find((e) => e.action === 'agent.run.request' && e.resourceId === runId)?.decision).toBe(
        'allowed',
      );
      expect((await outboxFor(runId)).map((e) => e.eventType)).toEqual(['agent.run_requested']);
      const after = await domainRows();
      expect(after.counts['agent_runs']).toBe((before.counts['agent_runs'] ?? 0) + 1);
    });

    it('content.createBrief creates a draft brief of the brand recorded as the key’s principal', async () => {
      const writer = await seedApiClient(tdb.db, tenantA, {
        grants: [
          { action: 'brand.read', brandIds: 'all' },
          { action: 'content.plan', brandIds: 'all' },
        ],
        scopes: ['content:write'],
        maxAutonomy: 'create',
      });
      const res = await callMcpTool({ bearer: writer.key }, 'content.createBrief', {
        brandId: tenantA.brandIds[0],
        audience: 'Runners in Harare',
        message: 'The autumn range is in store',
      });
      expect(res.error).toBeUndefined();
      expect(res.data).toMatchObject({ state: 'draft' });
      const briefId = res.data?.['briefId'] as string;
      const [brief] = await tdb.db
        .select()
        .from(briefs)
        .where(and(eq(briefs.tenantId, tenantA.tenantId), eq(briefs.id, briefId)));
      expect(brief).toMatchObject({ brandId: tenantA.brandIds[0], state: 'draft' });
      expect(JSON.stringify(brief)).toContain(writer.servicePrincipalId);
      const trail = await auditFor(writer.servicePrincipalId);
      expect(trail.find((e) => e.action === 'agent.tool.content.createBrief')?.decision).toBe('allowed');
    });

    it('review.request opens a review request on a draft revision of the brand', async () => {
      const writer = await seedApiClient(tdb.db, tenantA, {
        grants: [
          { action: 'brand.read', brandIds: 'all' },
          { action: 'review.request', brandIds: 'all' },
        ],
        scopes: ['review:write'],
        maxAutonomy: 'prepare_release', // requesting review prepares a release: refused below that mode
      });
      // The brand's policy is activated in the product; the revision is written against the brand's current
      // published version and active policy, with a channel variant (what a review request freezes).
      const owner = { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId };
      const policy = (
        await callPath(owner, 'brand.policy.createVersion', {
          brandId: tenantA.brandIds[0],
          document: defaultPolicyDocument(),
        })
      ).data as { policyVersionId: string };
      const current = (await callPath(owner, 'brand.get', { brandId: tenantA.brandIds[0] })).data as {
        version: number;
      };
      const activated = await callPath(owner, 'brand.policy.activate', {
        brandId: tenantA.brandIds[0],
        policyVersionId: policy.policyVersionId,
        expectedVersion: current.version,
      });
      expect(activated.error).toBeUndefined();
      const [brand] = await tdb.db.select().from(brands).where(eq(brands.id, tenantA.brandIds[0]));
      const pkg = await seedContentPackage(
        tdb.db,
        {
          tenantId: tenantA.tenantId,
          brandId: tenantA.brandIds[0],
          ownerUserId: tenantA.ownerUserId,
          brandVersionId: brand!.publishedVersionId!,
          policyVersionId: brand!.activePolicyVersionId!,
        },
        'mcp-review',
      );
      const res = await callMcpTool({ bearer: writer.key }, 'review.request', {
        brandId: tenantA.brandIds[0],
        contentRevisionId: pkg.contentRevisionId,
        timing: { kind: 'exact', at: new Date(Date.now() + 3 * 86_400_000).toISOString() },
      });
      expect(res.error).toBeUndefined();
      expect(res.data).toMatchObject({ state: 'open' });
      const reviewRequestId = res.data?.['reviewRequestId'] as string;
      const [request] = await tdb.db
        .select()
        .from(reviewRequests)
        .where(and(eq(reviewRequests.tenantId, tenantA.tenantId), eq(reviewRequests.id, reviewRequestId)));
      expect(request).toMatchObject({
        contentRevisionId: pkg.contentRevisionId,
        requestedById: writer.servicePrincipalId,
        state: 'open',
      });
      expect((await outboxFor(reviewRequestId)).map((e) => e.eventType)).toContain('review.requested');
      const trail = await auditFor(writer.servicePrincipalId);
      expect(trail.find((e) => e.action === 'agent.tool.review.request')?.decision).toBe('allowed');
    });

    it('creative.proposeOperations hands a clean batch to a person as a proposal and applies nothing', async () => {
      const writer = await seedApiClient(tdb.db, tenantA, {
        grants: [
          { action: 'brand.read', brandIds: 'all' },
          { action: 'creative.edit', brandIds: 'all' },
        ],
        scopes: ['creative:write'],
        maxAutonomy: 'create',
      });
      const before = await domainRows();
      const res = await callMcpTool({ bearer: writer.key }, 'creative.proposeOperations', {
        brandId: tenantA.brandIds[0],
        documentId: tenantA.ids['creativeDocumentId'],
        baseRevisionId: tenantA.ids['creativeRevisionId'],
        operations: [
          { op: 'setLock', pageId: 'page_1', elementId: tenantA.ids['creativeElementId'], locked: true },
        ],
        summary: 'Lock the headline',
      });
      expect(res.error).toBeUndefined();
      expect(res.data).toMatchObject({
        kind: 'proposal_requires_user',
        proposal: { documentId: tenantA.ids['creativeDocumentId'], summary: 'Lock the headline' },
      });
      expect(res.data?.['proposalRef']).toBeTruthy();
      const trail = await auditFor(writer.servicePrincipalId);
      expect(trail.find((e) => e.action === 'agent.tool.creative.proposeOperations')?.decision).toBe(
        'allowed',
      );
      // A proposal is a preview: no revision, no operation, no event (the idempotency record is not a domain row).
      const after = await domainRows();
      delete after.counts['idempotency_keys'];
      delete before.counts['idempotency_keys'];
      expect(after).toEqual(before);
    });
  });

  describe('replay protection for write tools (spec 7.1 / 7.3, ledger T.3)', () => {
    const startArgs = (objective: string) => ({
      brandId: tenantA.brandIds[0],
      taskKind: 'copywriting',
      brief: { objective },
    });
    const runCount = async () => (await domainRows()).counts['agent_runs'] ?? 0;

    it('a write tool needs the Idempotency-Key header (VALIDATION_FAILED, -32602, nothing written); a read tool does not', async () => {
      const before = await runCount();
      const res = await rpc(full.key, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'agents.startRun', arguments: startArgs('no key') },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        error: { code: number; data: { code: string; details: unknown } };
      };
      expect(body.error.code).toBe(-32602);
      expect(body.error.data).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'Idempotency-Key', issue: 'required' }],
      });
      const tooLong = (await (
        await rpc(
          full.key,
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'agents.startRun', arguments: startArgs('long key') },
          },
          { 'idempotency-key': 'k'.repeat(121) },
        )
      ).json()) as { error: { data: { code: string } } };
      expect(tooLong.error.data.code).toBe('VALIDATION_FAILED');
      expect(await runCount()).toBe(before);
      for (const name of ['content.createBrief', 'creative.proposeOperations', 'review.request']) {
        const unkeyed = (await (
          await rpc(full.key, {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name, arguments: { brandId: tenantA.brandIds[0] } },
          })
        ).json()) as { error?: { data: { details?: Array<{ path?: string }> } } };
        expect(unkeyed.error?.data.details, name).toEqual([{ path: 'Idempotency-Key', issue: 'required' }]);
      }
      const read = (await (
        await rpc(full.key, {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'insights.list', arguments: { brandId: tenantA.brandIds[0] } },
        })
      ).json()) as { result?: unknown; error?: unknown };
      expect(read.error).toBeUndefined();
      expect(read.result).toBeDefined();
    });

    it('the same key replays the stored result without running the tool again; other arguments or another tool are IDEMPOTENCY_KEY_REUSED', async () => {
      const key = randomUUID();
      const before = await runCount();
      const call = (args: Record<string, unknown>, name = 'agents.startRun') =>
        rpc(
          full.key,
          { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } },
          { 'idempotency-key': key },
        ).then(
          (r) => r.json() as Promise<{ result?: unknown; error?: { code: number; data: { code: string } } }>,
        );
      const first = await call(startArgs('replayed'));
      expect(first.error).toBeUndefined();
      const replay = await call(startArgs('replayed'));
      expect(replay.result).toEqual(first.result);
      expect(await runCount()).toBe(before + 1); // one run, however often the call is retried
      const reused = await call(startArgs('something else'));
      expect(reused.error?.code).toBe(-32000);
      expect(reused.error?.data.code).toBe('IDEMPOTENCY_KEY_REUSED');
      const otherTool = await call(
        { brandId: tenantA.brandIds[0], audience: 'a', message: 'b' },
        'content.createBrief',
      );
      expect(otherTool.error?.data.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await runCount()).toBe(before + 1);
      // Keys belong to the principal: another key's principal may use the same key string independently.
      const other = await seedApiClient(tdb.db, tenantA, {
        grants: ['brand.read', 'agent.start_run'].map((action) => ({ action, brandIds: 'all' as const })),
        scopes: ['agents:write'],
        maxAutonomy: 'create',
      });
      const theirs = await callMcpTool({ bearer: other.key, idempotencyKey: key }, 'agents.startRun', {
        ...startArgs('replayed'),
      });
      expect(theirs.error).toBeUndefined();
      expect(theirs.data?.['runId']).not.toBe(
        (first.result as { structuredContent: { runId: string } }).structuredContent.runId,
      );
    });

    it('a call still in progress under the key is CONFLICT with retryAfterMs and Retry-After (the 409 of REST)', async () => {
      const key = randomUUID();
      const args = startArgs('in progress');
      const path = 'mcp:agents.startRun';
      await tdb.db.insert(idempotencyKeys).values({
        tenantId: tenantA.tenantId,
        principalId: full.servicePrincipalId,
        key,
        path,
        requestHash: hashRequest(path, args),
        state: 'in_progress',
        expiresAt: new Date(Date.now() + 60_000),
      });
      const before = await runCount();
      const res = await rpc(
        full.key,
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'agents.startRun', arguments: args } },
        { 'idempotency-key': key },
      );
      expect(res.headers.get('retry-after')).toBe('2');
      const body = (await res.json()) as {
        error: { code: number; data: { code: string; retryAfterMs: number } };
      };
      expect(body.error.code).toBe(-32000);
      expect(body.error.data).toMatchObject({ code: 'CONFLICT', retryAfterMs: 2000 });
      expect(await runCount()).toBe(before);
    });

    it('a refused call stores nothing: the same key runs once the cause is fixed', async () => {
      const key = randomUUID();
      const bad = await callMcpTool({ bearer: full.key, idempotencyKey: key }, 'agents.startRun', {
        ...startArgs('refused first'),
        taskKind: 'not_a_task_kind',
      });
      expect(bad.error?.code).toBe('VALIDATION_FAILED');
      const stored = await tdb.db
        .select()
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.tenantId, tenantA.tenantId), eq(idempotencyKeys.key, key)));
      expect(stored).toEqual([]);
      const good = await callMcpTool(
        { bearer: full.key, idempotencyKey: key },
        'agents.startRun',
        startArgs('refused first'),
      );
      expect(good.error).toBeUndefined();
      expect(good.data?.['runId']).toBeTruthy();
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
