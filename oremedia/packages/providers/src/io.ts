import { fetch, type Dispatcher, type Response } from 'undici';
import { logger, count, METRIC } from '@oremedia/observability';
import { assertSafeUrl, ssrfSafeDispatcher, type SafeDispatcherOptions } from './ssrf';
import type { RateLimiter } from './rate-limiter';

export type SendPhase = 'before_send' | 'after_send';

/** A transport failure, classified by whether the request may have reached the platform (spec 14.5). */
export class ProviderTransportError extends Error {
  readonly phase: SendPhase;
  readonly code: string;
  constructor(cause: unknown, phase: SendPhase) {
    const c = cause as { code?: string; name?: string; message?: string } | undefined;
    super(`provider transport error (${phase}): ${c?.code ?? c?.name ?? 'unknown'}`, { cause });
    this.name = 'ProviderTransportError';
    this.phase = phase;
    this.code = c?.code ?? c?.name ?? 'UNKNOWN';
  }
}

export interface ProviderRequestMeta {
  /** true for anything that could create, change or delete remote state. */
  mutation: boolean;
  /** Heartbeat detail hook supplied by the activity (spec 20.3: per-activity context, never a singleton). */
  heartbeat?: (detail: string) => void;
}

export interface ProviderIO {
  request(
    url: string,
    init: Omit<RequestInit, 'body'> & { body?: string | Uint8Array | FormData },
    meta: ProviderRequestMeta,
  ): Promise<{ res: Response; phase: 'after_send' }>;
}

export interface ProviderIOOptions extends SafeDispatcherOptions {
  providerKey: string;
  tenantId: string;
  timeoutMs: number;
  limiter: RateLimiter;
  /**
   * Awaited once, immediately before the first `mutation: true` request is dispatched (after the SSRF and rate-limit
   * checks, which never reach the platform). The publishing runtime commits the attempt's sentAt here (spec 14.3),
   * so read-only requests and pre-send failures before the first mutation leave the ledger unsent. A throw aborts
   * the request (and every later mutation of this IO) as `before_send`: nothing left the process.
   */
  beforeSend?: () => Promise<void>;
}

/**
 * Spec 14.5: the only way an adapter performs network I/O. Wraps the SSRF-safe dispatcher, an explicit per-request
 * timeout, structured redacting logs, heartbeat detail recording and rate-limit accounting.
 *
 * Send tracking: the dispatcher is composed with an interceptor that flips `sent` once the request has started
 * on an established connection. Failures before that (DNS, blocked address, connection refused) are `before_send`;
 * everything after, including timeouts and socket resets, is `after_send`. Being conservative costs a reconciliation,
 * which is cheap; being optimistic costs a duplicate public post.
 */
export function createProviderIO(opts: ProviderIOOptions): ProviderIO {
  const log = logger().child('provider-io');
  const base = ssrfSafeDispatcher(opts);
  let beforeSend: Promise<void> | null = null;
  return {
    async request(url, init, meta) {
      const target = assertSafeUrl(url, opts);
      await opts.limiter.acquire(opts.providerKey, opts.tenantId);
      const method = (init.method ?? 'GET').toUpperCase();
      const detail = `${meta.mutation ? 'mutation' : 'read'} ${method} ${target.origin}${target.pathname}`;
      meta.heartbeat?.(detail);
      if (meta.mutation && opts.beforeSend) {
        try {
          await (beforeSend ??= opts.beforeSend());
        } catch (err) {
          log.warn(
            {
              providerKey: opts.providerKey,
              tenantId: opts.tenantId,
              method,
              path: target.pathname,
              phase: 'before_send',
              errorName: (err as Error)?.name,
              errorCode: (err as { code?: string })?.code,
            },
            'provider request aborted before send',
          );
          throw new ProviderTransportError(err, 'before_send');
        }
      }
      let sent = false;
      const dispatcher = sendTracking(base, () => {
        sent = true;
      });
      const started = Date.now();
      try {
        const res = await fetch(target, {
          ...init,
          dispatcher,
          signal: AbortSignal.timeout(opts.timeoutMs),
          redirect: 'manual',
        } as never);
        log.info(
          {
            providerKey: opts.providerKey,
            tenantId: opts.tenantId,
            method,
            path: target.pathname,
            statusCode: res.status,
            durationMs: Date.now() - started,
          },
          'provider request',
        );
        if (res.status === 429) count(METRIC.providerRateLimitHits, 1, { providerKey: opts.providerKey });
        return { res, phase: 'after_send' as const };
      } catch (err) {
        const phase: SendPhase = sent || meta.mutation ? 'after_send' : 'before_send';
        // Where the client could not report whether the request was sent, a mutation failure is after_send.
        const classified = sent ? 'after_send' : isPreConnectError(err) ? 'before_send' : phase;
        log.warn(
          {
            providerKey: opts.providerKey,
            tenantId: opts.tenantId,
            method,
            path: target.pathname,
            phase: classified,
            durationMs: Date.now() - started,
            errorName: (err as Error)?.name,
            errorCode: (err as { code?: string })?.code,
          },
          'provider request failed',
        );
        throw new ProviderTransportError(err, classified);
      }
    },
  };
}

const PRE_CONNECT_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
// undici sometimes surfaces connect failures as plain Errors whose only signal is the message.
const PRE_CONNECT_MESSAGE =
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|connect timeout|Blocked address|bad port/i;
function isPreConnectError(err: unknown): boolean {
  // fetch wraps transport errors: TypeError('fetch failed') → cause (Error | AggregateError with .errors[]).
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length) {
    const e = stack.pop() as
      { code?: string; name?: string; cause?: unknown; errors?: unknown[] } | undefined;
    if (!e || typeof e !== 'object' || seen.has(e)) continue;
    seen.add(e);
    if (e.name === 'BlockedAddressError') return true;
    if (typeof e.code === 'string' && PRE_CONNECT_CODES.has(e.code)) return true;
    const message = (e as { message?: string }).message;
    if (typeof message === 'string' && PRE_CONNECT_MESSAGE.test(message)) return true;
    if (e.cause) stack.push(e.cause);
    if (Array.isArray(e.errors)) stack.push(...e.errors);
  }
  return false;
}

/** Composes a dispatcher with a handler wrapper that reports when the request has started on a live connection. */
export function sendTracking(dispatcher: Dispatcher, onSent: () => void): Dispatcher {
  return dispatcher.compose((dispatch) => (opts, handler) => {
    const wrapped = new Proxy(handler as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (
          (prop === 'onRequestStart' ||
            prop === 'onConnect' ||
            prop === 'onRequestSent' ||
            prop === 'onBodySent') &&
          typeof value === 'function'
        ) {
          return (...args: unknown[]) => {
            onSent();
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as typeof handler;
    return dispatch(opts, wrapped);
  });
}
