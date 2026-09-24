import type { IncomingHttpHeaders } from 'node:http';
import express, { type Request, type Response, type Router } from 'express';
import {
  defaultDispatchDeps,
  type AnyToolDefinition,
  type DispatchDeps,
  type ToolRegistry,
} from '@oremedia/ai';
import type { ToolResult } from '@oremedia/contracts/agents';
import {
  httpStatusFor,
  NotFoundError,
  toErrorEnvelope,
  UnauthenticatedError,
  ValidationFailedError,
  type ErrorCode,
  type ErrorEnvelope,
} from '@oremedia/contracts/errors';
import { runInTenant, type Tx } from '@oremedia/db';
import { resolveTenantContext, type ResolvedTenant } from '@oremedia/module-access';
import { dispatchSurfaceToolCall } from '@oremedia/module-agents';
import { brandService } from '@oremedia/module-brand';
import { hashRequest, idempotent } from '@oremedia/module-operations';
import { withLogContext } from '@oremedia/observability';
import { createContext, type RequestContext } from '../context';
import { assertApiScope, consumeRateLimit } from '../trpc';
import { MCP_TOOLS, createMcpRegistry } from './tools';

/**
 * Spec 7.6 MCP server over Streamable HTTP, implemented on plain Express: `@modelcontextprotocol/sdk` is not a
 * dependency of this workspace. Each POST /mcp carries one JSON-RPC 2.0 message; the server answers with one JSON
 * body (`application/json`, no SSE stream, no session id: every request is authenticated and stateless). Methods:
 * `initialize`, `ping`, `tools/list`, `tools/call`; notifications (no `id`) are accepted with 202. Batches are
 * rejected (removed from the protocol in 2025-06-18).
 *
 * Authentication is an API client key (a service principal, spec 7.6); the tenant is the key's own. Every tool call
 * runs through dispatchToolDetailed with an AgentRunContext built for that principal, so the policy engine, audit,
 * budgets and timeouts are those of internal agents (spec 12.4). Failures are JSON-RPC errors whose `data` is the
 * spec 7.2 error envelope, so MCP clients branch on the same codes as REST and tRPC clients.
 *
 * Replay protection (spec 7.1 / 7.3, ledger T.3): a tools/call of a tool whose effect is not `read` (draft, propose)
 * carries the HTTP `Idempotency-Key` header, exactly as a REST POST or a tRPC mutation does. The header is the
 * carrier because every JSON-RPC message is its own HTTP request here (batches are rejected), so a key names one
 * tool call. As on REST the key is required for those tools (missing or over 120 characters → VALIDATION_FAILED,
 * JSON-RPC -32602, details `Idempotency-Key: required`) and ignored for read tools. The call runs inside the
 * operations module's `idempotent()`: the tool's writes, its audit and outbox events and the stored result commit
 * together; the same key with the same tool and arguments replays the stored result without running the tool again;
 * the same key with other arguments or another tool is IDEMPOTENCY_KEY_REUSED; a call still in progress under the
 * key is CONFLICT with retryAfterMs (JSON-RPC -32000, `Retry-After` header). Keys belong to the service principal,
 * as on tRPC and REST, and the request hash covers `mcp:<tool name>` and the full arguments (brandId included).
 * A refused or failed call stores nothing, so an honest retry under the same key runs.
 */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
export const MCP_SERVER_INFO = { name: 'oremedia', version: '0.1.0' } as const;

/** JSON-RPC 2.0 error codes: the reserved ones, and -32000 for a domain error (the envelope says which). */
const JSONRPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  domain: -32000,
} as const;

type JsonRpcId = string | number | null;
export interface McpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  failure?: unknown;
}

class JsonRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

const rpcCodeFor = (code: ErrorCode): number =>
  code === 'VALIDATION_FAILED'
    ? JSONRPC.invalidParams
    : code === 'INTERNAL'
      ? JSONRPC.internal
      : JSONRPC.domain;

export interface McpDeps {
  registry: ToolRegistry;
  dispatch: DispatchDeps;
}

let defaultDeps: McpDeps | null = null;
function mcpDeps(): McpDeps {
  if (!defaultDeps) {
    const registry = createMcpRegistry();
    defaultDeps = { registry, dispatch: defaultDispatchDeps(registry) };
  }
  return defaultDeps;
}

const withBrandArgument = (schema: Record<string, unknown>): Record<string, unknown> => ({
  ...schema,
  properties: {
    brandId: { type: 'string', maxLength: 32, description: 'The brand this call acts in (see brands.list).' },
    ...((schema['properties'] as Record<string, unknown> | undefined) ?? {}),
  },
  required: ['brandId', ...((schema['required'] as string[] | undefined) ?? [])],
});

/** tools/list: the registry's schema for each exposed tool (plus the brand argument for brand-scoped tools). */
export function listMcpTools(registry: ToolRegistry = mcpDeps().registry) {
  return MCP_TOOLS.flatMap((exposure) => {
    const def = registry.get(exposure.name) as AnyToolDefinition | undefined;
    if (!def) return [];
    return [
      {
        name: def.name,
        description: def.description,
        inputSchema: exposure.brandScoped ? withBrandArgument(def.inputSchema) : def.inputSchema,
        annotations: { readOnlyHint: def.effect === 'read', destructiveHint: false, openWorldHint: false },
      },
    ];
  });
}

/** A dispatcher outcome other than ok, as the envelope every surface uses. */
function envelopeForResult(
  result: Exclude<ToolResult, { kind: 'ok' }>,
  correlationId: string,
): ErrorEnvelope {
  if (result.kind === 'invalid')
    return { code: 'VALIDATION_FAILED', message: 'Validation failed', correlationId, details: result.issues };
  if (result.kind === 'denied') {
    // A tool that threw a domain error is denied with the error's code as reason (not_found, validation_failed).
    if (result.reason === 'not_found') return { code: 'NOT_FOUND', message: 'Not found', correlationId };
    if (result.reason === 'validation_failed')
      return { code: 'VALIDATION_FAILED', message: 'Validation failed', correlationId };
    return {
      code: 'FORBIDDEN',
      message: 'You are not allowed to perform this action',
      correlationId,
      details: [{ issue: result.reason }],
    };
  }
  return { code: 'INTERNAL', message: 'Something went wrong', correlationId };
}

async function callTool(
  params: Record<string, unknown>,
  ctx: RequestContext,
  tenant: ResolvedTenant,
  deps: McpDeps,
): Promise<unknown> {
  const name = params['name'];
  const rawArgs = params['arguments'] ?? {};
  if (typeof name !== 'string' || name.length > 120 || typeof rawArgs !== 'object' || Array.isArray(rawArgs))
    throw new ValidationFailedError([
      { path: 'params', issue: 'name (string) and arguments (object) required' },
    ]);
  const { brandId: rawBrandId, ...args } = rawArgs as Record<string, unknown>;
  const principal = tenant.actor;
  if (principal.kind !== 'service_principal')
    throw new UnauthenticatedError('MCP requires an API client key');
  const exposure = MCP_TOOLS.find((t) => t.name === name);
  let brandId = '';
  if (exposure) {
    await assertApiScope(
      ctx.principal as NonNullable<RequestContext['principal']>,
      tenant,
      exposure.scope,
      name,
    );
    if (exposure.brandScoped) {
      if (typeof rawBrandId !== 'string' || !rawBrandId)
        throw new ValidationFailedError([{ path: 'brandId', issue: 'required' }]);
      // Spec 5.3: a brand outside the principal's grants or in another tenant is NOT_FOUND, as on tRPC and REST.
      const visible = tenant.context.brandIds === 'all' || tenant.context.brandIds.has(rawBrandId);
      if (!visible) throw new NotFoundError('Brand', rawBrandId.slice(0, 32));
      await brandService.assertExist([rawBrandId]);
      brandId = rawBrandId;
    } else if (rawBrandId !== undefined) args['brandId'] = rawBrandId; // the tool's schema rejects it
  }
  const invoke = (dispatch: DispatchDeps) =>
    dispatchSurfaceToolCall(
      {
        tenantContext: tenant.context,
        principal,
        brandId,
        correlationId: ctx.correlationId,
        allowedTools: MCP_TOOLS.map((t) => t.name),
        name,
        arguments: args,
      },
      dispatch,
    ).then((outcome) => toolCallResult(outcome, ctx.correlationId));
  const def = exposure ? (deps.registry.get(name) as AnyToolDefinition | undefined) : undefined;
  if (!def || def.effect === 'read') return invoke(deps.dispatch);
  const path = `mcp:${name}`;
  return idempotent(
    {
      idempotency: { key: idempotencyKeyOf(ctx.headers), path, requestHash: hashRequest(path, rawArgs) },
      actor: { kind: tenant.actorRef.kind, id: tenant.actorRef.id },
    },
    // The tool runs in the idempotency transaction, so its writes and the stored result commit together.
    (tx: Tx) => invoke({ ...deps.dispatch, transaction: (fn) => fn(tx) }),
  );
}

/** Spec 7.1: the same header and bound as the tRPC idempotencyKey middleware (and so REST). */
function idempotencyKeyOf(headers: IncomingHttpHeaders): string {
  const header = headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || key.length > 120)
    throw new ValidationFailedError(
      [{ path: 'Idempotency-Key', issue: 'required' }],
      'Idempotency-Key header is required',
    );
  return key;
}

/** The MCP tools/call result for a dispatcher outcome; anything but ok or a proposal throws its envelope. */
function toolCallResult(
  { result, record }: Awaited<ReturnType<typeof dispatchSurfaceToolCall>>,
  correlationId: string,
): Record<string, unknown> {
  if (result.kind === 'ok') {
    const output = result.output as Record<string, unknown>;
    return {
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
      isError: false,
    };
  }
  if (result.kind === 'proposal_requires_user') {
    // A proposal is a preview for a person to decide in the product; nothing was applied.
    const structured = { kind: result.kind, proposalRef: result.proposalRef, proposal: record.proposal };
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
      isError: false,
    };
  }
  throw Object.assign(new Error('tool call failed'), {
    envelope: envelopeForResult(result, correlationId),
  });
}

const errorBody = (id: JsonRpcId, envelope: ErrorEnvelope) => ({
  jsonrpc: '2.0',
  id,
  error: { code: rpcCodeFor(envelope.code), message: envelope.message, data: envelope },
});

/** One Streamable HTTP POST: authenticate, resolve the tenant, rate-limit, then run the JSON-RPC method. */
export async function handleMcpRequest(
  headers: IncomingHttpHeaders,
  message: unknown,
  remoteAddress?: string,
  deps: McpDeps = mcpDeps(),
): Promise<McpResponse> {
  const { cookie: _cookie, ...bearerHeaders } = headers; // bearer only, like the public REST API
  const ctx = await createContext(bearerHeaders, remoteAddress);
  const out: Record<string, string> = { 'x-correlation-id': ctx.correlationId };
  const isObject = message !== null && typeof message === 'object' && !Array.isArray(message);
  const msg = (isObject ? message : {}) as Record<string, unknown>;
  const id: JsonRpcId =
    typeof msg['id'] === 'string' || typeof msg['id'] === 'number' ? (msg['id'] as string | number) : null;
  const rpcError = (rpcCode: number, text: string, code: ErrorCode = 'VALIDATION_FAILED'): McpResponse => ({
    status: 200,
    headers: out,
    body: {
      jsonrpc: '2.0',
      id,
      error: {
        code: rpcCode,
        message: text,
        data: { code, message: text, correlationId: ctx.correlationId },
      },
    },
  });
  const failure = (err: unknown, transportStatus: boolean): McpResponse => {
    const envelope: ErrorEnvelope =
      (err as { envelope?: ErrorEnvelope }).envelope ?? toErrorEnvelope(err, ctx.correlationId);
    if (envelope.retryAfterMs) out['retry-after'] = String(Math.ceil(envelope.retryAfterMs / 1000));
    if (envelope.code === 'UNAUTHENTICATED') out['www-authenticate'] = 'Bearer';
    return {
      status: transportStatus ? httpStatusFor(envelope.code) : 200,
      headers: out,
      body: errorBody(id, envelope),
      ...(envelope.code === 'INTERNAL' ? { failure: err } : {}),
    };
  };

  if (Array.isArray(message)) return rpcError(JSONRPC.invalidRequest, 'Batch requests are not supported');
  if (!isObject || msg['jsonrpc'] !== '2.0' || typeof msg['method'] !== 'string')
    return rpcError(JSONRPC.invalidRequest, 'Invalid JSON-RPC 2.0 request');
  const method = msg['method'] as string;

  // Authentication, tenant and rate limit come first and fail at the transport (401/403/429), as on REST.
  let tenant: ResolvedTenant;
  try {
    if (!ctx.principal || ctx.principal.kind !== 'api_client')
      throw new UnauthenticatedError('An API client key is required');
    tenant = await resolveTenantContext(ctx.principal, ctx.requestedTenantId, ctx.correlationId);
    await consumeRateLimit(ctx.principal, tenant, `mcp.${method.slice(0, 40)}`);
  } catch (err) {
    return failure(err, true);
  }
  if (!('id' in msg)) return { status: 202, headers: out, body: undefined }; // a notification: no response

  const params = (msg['params'] ?? {}) as Record<string, unknown>;
  try {
    const result = await withLogContext(
      { correlationId: ctx.correlationId, tenantId: tenant.context.tenantId },
      () =>
        runInTenant(tenant.context, async (): Promise<unknown> => {
          switch (method) {
            case 'initialize': {
              const requested = params['protocolVersion'];
              return {
                protocolVersion: MCP_PROTOCOL_VERSIONS.includes(
                  requested as (typeof MCP_PROTOCOL_VERSIONS)[number],
                )
                  ? requested
                  : LATEST_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: MCP_SERVER_INFO,
                instructions:
                  'Oremedia brand studio tools. Call brands.list first; every other tool acts in one brand (brandId). No tool publishes or schedules: scheduling needs an approval in the product.',
              };
            }
            case 'ping':
              return {};
            case 'tools/list':
              return { tools: listMcpTools(deps.registry) };
            case 'tools/call':
              return callTool(params, ctx, tenant, deps);
            default:
              throw new JsonRpcError(JSONRPC.methodNotFound, `Method not found: ${method.slice(0, 60)}`);
          }
        }),
    );
    return { status: 200, headers: out, body: { jsonrpc: '2.0', id, result } };
  } catch (err) {
    if (err instanceof JsonRpcError) return rpcError(err.rpcCode, err.message);
    return failure(err, false);
  }
}

/** The /mcp Express router: POST carries JSON-RPC; GET (server-initiated SSE) and DELETE (sessions) are not offered. */
export function createMcpRouter(onInternal: (cause: unknown) => void): Router {
  const router = express.Router();
  router.post('/', express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const out = await handleMcpRequest(req.headers, req.body, req.ip);
    if (out.failure !== undefined) onInternal(out.failure);
    res.status(out.status).set(out.headers);
    if (out.body === undefined) res.end();
    else res.json(out.body);
  });
  router.all('/', (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').end();
  });
  router.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    if ((err as { type?: string } | null)?.type === 'entity.parse.failed') {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: JSONRPC.parseError, message: 'Parse error' },
      });
      return;
    }
    next(err);
  });
  return router;
}
