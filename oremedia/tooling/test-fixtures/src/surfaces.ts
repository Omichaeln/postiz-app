import {
  allRestRoutes,
  handleMcpRequest,
  invokeRestRoute,
  restRequestFor,
  type RestRoute,
} from '@oremedia/api';
import type { ErrorEnvelope } from '@oremedia/contracts/errors';
import { headersFor, type CallOptions } from './seed';

/**
 * In-process callers for the public REST API and the MCP server (spec 7.6), with the same headers an HTTP client
 * sends; the transport-level tests in apps/api go over real HTTP. Both return the data or the error envelope.
 */
export function restRoute(procedure: string): RestRoute {
  const route = allRestRoutes().find((r) => r.procedure === procedure);
  if (!route) throw new Error(`no REST route serves ${procedure}`);
  return route;
}

export async function callRest(
  opts: CallOptions,
  route: RestRoute,
  input: unknown,
): Promise<{ status: number; data?: unknown; error?: ErrorEnvelope; headers: Record<string, string> }> {
  const res = await invokeRestRoute(route, { headers: headersFor(opts), ...restRequestFor(route, input) });
  return res.status < 400
    ? { status: res.status, data: res.body, headers: res.headers }
    : { status: res.status, error: res.body as ErrorEnvelope, headers: res.headers };
}

let rpcId = 0;
export async function callMcp(
  opts: CallOptions,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ status: number; result?: unknown; error?: ErrorEnvelope; rpcCode?: number }> {
  const res = await handleMcpRequest(headersFor(opts), {
    jsonrpc: '2.0',
    id: ++rpcId,
    method,
    ...(params ? { params } : {}),
  });
  const body = res.body as { result?: unknown; error?: { code: number; data?: ErrorEnvelope } } | undefined;
  return body?.error
    ? { status: res.status, error: body.error.data, rpcCode: body.error.code }
    : { status: res.status, result: body?.result };
}

/** tools/call with the MCP result unwrapped to its structured content. */
export async function callMcpTool(
  opts: CallOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; data?: Record<string, unknown>; error?: ErrorEnvelope }> {
  const res = await callMcp(opts, 'tools/call', { name, arguments: args });
  if (res.error) return { status: res.status, error: res.error };
  return {
    status: res.status,
    data: (res.result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {},
  };
}
