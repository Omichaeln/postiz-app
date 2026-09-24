import type { IncomingHttpHeaders } from 'node:http';
import { TRPCError } from '@trpc/server';
import { ZodObject, type ZodTypeAny } from 'zod';
import type { ApiScope } from '@oremedia/contracts/access';
import { httpStatusFor, type ErrorEnvelope } from '@oremedia/contracts/errors';
import { PAGE_DEFAULT, PAGE_MAX } from '@oremedia/contracts/pagination';
import { createContext } from '../context';
import { appRouter } from '../router';
import { scopeForProcedure } from '../scopes';
import { envelopeFor } from '../trpc';

/**
 * Spec 7.6 public REST. A route is data: its HTTP shape and the tRPC procedure it serves. The handler calls that
 * procedure through a server-side caller built from the same createContext as /trpc, so the request passes the
 * identical chain (authentication, tenant resolution, per-key scope, rate limit, Idempotency-Key, the application
 * command inside `idempotent`, audit, the error envelope). Nothing is re-implemented here: a REST route cannot
 * diverge from the product's authorisation because it has no authorisation code of its own.
 */
export interface RestRouteSpec {
  method: 'GET' | 'POST';
  /** Express path under /v1, e.g. `/v1/brands/:brandId`. Path parameters are top-level input fields. */
  path: string;
  /** The tRPC procedure this route serves (spec 7.6: the same application command). */
  procedure: string;
  summary: string;
  successStatus?: 200 | 201;
}

export interface RestRoute extends RestRouteSpec {
  type: 'query' | 'mutation';
  /** The per-key scope the route needs: the scope of its procedure (scopes.ts). */
  scope: ApiScope;
  pathParams: string[];
  input: ZodTypeAny | null;
}

type ProcedureDefs = Record<
  string,
  { _def: { type: 'query' | 'mutation' | 'subscription'; inputs?: unknown[] } }
>;

/** Binds a route to its procedure; a route naming a missing procedure or a mutation behind GET fails at startup. */
export function resolveRoute(spec: RestRouteSpec): RestRoute {
  const proc = (appRouter._def.procedures as unknown as ProcedureDefs)[spec.procedure];
  if (!proc || proc._def.type === 'subscription')
    throw new Error(`REST route ${spec.method} ${spec.path}: no procedure ${spec.procedure}`);
  const type = proc._def.type;
  if (spec.method === 'GET' && type === 'mutation')
    throw new Error(`REST route ${spec.path}: a mutation (${spec.procedure}) is never served by GET`);
  const input = (proc._def.inputs?.[0] as ZodTypeAny | undefined) ?? null;
  const pathParams = [...spec.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] as string);
  return { ...spec, type, scope: scopeForProcedure(spec.procedure, type), pathParams, input };
}

export interface RestRequest {
  headers: IncomingHttpHeaders;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  remoteAddress?: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  /** Set for INTERNAL only, so the transport can log the cause (never sent to the client). */
  failure?: unknown;
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/**
 * Spec 7.4 bounds: REST clamps `limit` into [1, 200] (default 50) instead of rejecting it, so a client asking for
 * more simply gets the maximum page; the cursor is passed through and validated by the procedure.
 */
export function clampPage(limit: unknown, cursor: unknown): { limit: number; cursor?: string } {
  const n = typeof limit === 'number' ? limit : Number.parseInt(String(limit ?? ''), 10);
  const bounded = Number.isFinite(n) ? Math.min(PAGE_MAX, Math.max(1, Math.trunc(n))) : PAGE_DEFAULT;
  return typeof cursor === 'string' && cursor ? { limit: bounded, cursor } : { limit: bounded };
}

const shapeOf = (route: RestRoute): Record<string, unknown> =>
  route.input instanceof ZodObject ? (route.input.shape as Record<string, unknown>) : {};

/** The procedure input: path parameters win over the body (POST) or the scalar query parameters (GET). */
export function inputFor(route: RestRoute, req: Pick<RestRequest, 'params' | 'query' | 'body'>): unknown {
  if (!route.input) return undefined;
  const shape = shapeOf(route);
  const params = Object.fromEntries(route.pathParams.map((p) => [p, req.params[p]]));
  if (route.method === 'GET') {
    const out: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(req.query)) {
      const v = first(raw);
      if (k !== 'page' && k in shape && typeof v === 'string') out[k] = v;
    }
    if ('page' in shape) out['page'] = clampPage(first(req.query['limit']), first(req.query['cursor']));
    return { ...out, ...params };
  }
  const body =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? { ...(req.body as Record<string, unknown>) }
      : {};
  if ('page' in shape) {
    const page = (body['page'] ?? {}) as { limit?: unknown; cursor?: unknown };
    body['page'] = clampPage(page.limit, page.cursor);
  }
  return { ...body, ...params };
}

/** The REST request that carries a procedure input (the inverse of inputFor; used by tests and the harness). */
export function restRequestFor(
  route: RestRoute,
  input: unknown,
): Pick<RestRequest, 'params' | 'query' | 'body'> & { url: string } {
  const rest = { ...((input ?? {}) as Record<string, unknown>) };
  const params: Record<string, string> = {};
  let url = route.path;
  for (const p of route.pathParams) {
    params[p] = String(rest[p] ?? '');
    url = url.replace(`:${p}`, encodeURIComponent(params[p]));
    delete rest[p];
  }
  if (route.method === 'POST') return { url, params, query: {}, body: rest };
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'page' && v && typeof v === 'object') {
      const page = v as { limit?: number; cursor?: string };
      if (page.limit !== undefined) query['limit'] = String(page.limit);
      if (page.cursor) query['cursor'] = page.cursor;
    } else if (v !== undefined && v !== null && typeof v !== 'object') query[k] = String(v);
  }
  const qs = new URLSearchParams(query).toString();
  return { url: qs ? `${url}?${qs}` : url, params, query, body: undefined };
}

/** Runs one REST request through the route's procedure and maps the outcome to HTTP (spec 7.2 envelope). */
export async function invokeRestRoute(route: RestRoute, req: RestRequest): Promise<RestResponse> {
  // Bearer only: a browser cookie is ignored, so the public API has no cookie session and no CSRF surface.
  const { cookie: _cookie, ...headers } = req.headers;
  const ctx = await createContext(headers, req.remoteAddress);
  const out: Record<string, string> = { 'x-correlation-id': ctx.correlationId };
  const caller = appRouter.createCaller(ctx);
  const call = route.procedure
    .split('.')
    .reduce<unknown>((acc, seg) => (acc as Record<string, unknown>)[seg], caller) as (
    input: unknown,
  ) => Promise<unknown>;
  try {
    const data = await call(inputFor(route, req));
    return { status: route.successStatus ?? 200, body: data ?? null, headers: out };
  } catch (err) {
    const error =
      err instanceof TRPCError ? err : new TRPCError({ code: 'INTERNAL_SERVER_ERROR', cause: err });
    const envelope: ErrorEnvelope = envelopeFor(error, ctx.correlationId);
    if (envelope.retryAfterMs) out['retry-after'] = String(Math.ceil(envelope.retryAfterMs / 1000));
    if (envelope.code === 'UNAUTHENTICATED') out['www-authenticate'] = 'Bearer';
    return {
      status: httpStatusFor(envelope.code),
      body: envelope,
      headers: out,
      ...(envelope.code === 'INTERNAL' ? { failure: error.cause ?? error } : {}),
    };
  }
}
