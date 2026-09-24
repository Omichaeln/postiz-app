import {
  createTRPCClient,
  httpBatchLink,
  httpLink,
  splitLink,
  type Operation,
  type TRPCClient,
} from '@trpc/client';
import { createTRPCContext, createTRPCOptionsProxy, type TRPCOptionsProxy } from '@trpc/tanstack-react-query';
import type { QueryClient } from '@tanstack/react-query';
import superjson from 'superjson';
import type { AppRouter } from '@oremedia/api';
import { readCookie } from './cookies';
import { newIntentKey } from './intent-key';
import { CSRF_COOKIE, getBearerToken } from './session';

/** Spec 7.1/7.3/18: the headers the API reads (apps/api/src/context.ts, trpc.ts). */
export const HEADER_TENANT = 'x-oremedia-tenant';
export const HEADER_CSRF = 'x-oremedia-csrf';
export const HEADER_CORRELATION = 'x-correlation-id';
export const HEADER_IDEMPOTENCY = 'idempotency-key';

/** Company identity lives in the URL (spec 21.1): `/c/:company/...`; the server re-verifies the selection. */
export function tenantFromPath(pathname: string): string | null {
  const m = /^\/c\/([^/]+)/.exec(pathname);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

export const apiUrl = (): string => (import.meta.env['VITE_API_URL'] as string | undefined) ?? '/trpc';

export interface ClientOptions {
  url?: string;
  /** Where the current path comes from (tests inject one). */
  pathname?: () => string;
  fetch?: typeof fetch;
  /**
   * Where the bearer token comes from. The app reads the per-tab session token; the review portal (spec 5.6, 21.1)
   * passes the `rl_…` link token it holds in memory, so reviewer credentials never touch the app's storage.
   */
  bearerToken?: () => string | null;
}

/** Per-request headers: tenant from the URL (or the operation context), CSRF double-submit, correlation id. */
export function headersFor(op: Operation, opts: ClientOptions): Record<string, string> {
  const headers: Record<string, string> = { [HEADER_CORRELATION]: `web-${crypto.randomUUID()}` };
  const ctx = op.context as { tenantId?: unknown; idempotencyKey?: unknown };
  const tenant =
    (typeof ctx.tenantId === 'string' && ctx.tenantId) ||
    tenantFromPath((opts.pathname ?? (() => window.location.pathname))());
  if (tenant) headers[HEADER_TENANT] = tenant;
  const bearer = opts.bearerToken ? opts.bearerToken() : getBearerToken();
  if (bearer) headers['authorization'] = `Bearer ${bearer}`;
  const csrf = readCookie(CSRF_COOKIE);
  if (csrf) headers[HEADER_CSRF] = csrf;
  if (op.type === 'mutation')
    // A mutation without an explicit intent key still gets one, but it is new on every attempt: callers that can be
    // retried must pass `intentContext(key)` so a retry replays instead of duplicating (spec 7.3).
    headers[HEADER_IDEMPOTENCY] =
      typeof ctx.idempotencyKey === 'string' ? ctx.idempotencyKey : newIntentKey();
  return headers;
}

export function createClient(opts: ClientOptions = {}): TRPCClient<AppRouter> {
  const url = opts.url ?? apiUrl();
  const baseFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  // The session cookie is first-party in production and via the dev proxy; credentials are always included.
  const fetchWithCredentials: typeof fetch = (input, init) =>
    baseFetch(input, { ...init, credentials: 'include' });
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        // Mutations are never batched: each carries its own Idempotency-Key header.
        condition: (op) => op.type === 'mutation',
        true: httpLink({
          url,
          transformer: superjson,
          fetch: fetchWithCredentials,
          headers: ({ op }) => headersFor(op, opts),
        }),
        false: httpBatchLink({
          url,
          transformer: superjson,
          fetch: fetchWithCredentials,
          headers: ({ opList }) => headersFor(opList[0], opts),
        }),
      }),
    ],
  });
}

const context = createTRPCContext<AppRouter>();
/** `useTRPC()` gives the options proxy: one `useQuery(trpc.x.y.queryOptions(input))` per hook (spec 21.1). */
export const TRPCProvider = context.TRPCProvider;
export const useTRPC = context.useTRPC;
export const useTRPCClient = context.useTRPCClient;

export type Trpc = TRPCOptionsProxy<AppRouter>;

/** The same proxy outside React (route loaders prefetch with it). */
export function createOptionsProxy(client: TRPCClient<AppRouter>, queryClient: QueryClient): Trpc {
  return createTRPCOptionsProxy<AppRouter>({ client, queryClient });
}
