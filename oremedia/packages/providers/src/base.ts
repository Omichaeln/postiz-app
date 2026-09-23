import type { ProviderErrorClass, PublishOutcome } from '@oremedia/contracts/providers';
import { ProviderTransportError } from './io';

/** Failure payloads are truncated before anything enters Temporal history (spec 20.3, gRPC frame limits). */
export const TEMPORAL_DETAIL_LIMIT = 2000;
export function truncateForTemporal(value: unknown, limit = TEMPORAL_DETAIL_LIMIT): string {
  const s =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? `${value.name}: ${value.message}`
        : (JSON.stringify(value) ?? String(value));
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/** Redacts obvious credential material from provider response bodies before they are stored or logged. */
export function redactBody(body: string): string {
  return body.replace(
    /("?(access_token|refresh_token|client_secret|token|authorization)"?\s*[:=]\s*)"?[A-Za-z0-9._~+/=-]{8,}"?/gi,
    '$1"[redacted]"',
  );
}

/**
 * Default classification shared by adapters. A response means the request reached the platform, so anything
 * ambiguous after a mutation is `unknown`. Adapters override with platform-specific knowledge (e.g. a documented
 * "rejected before effect" 429) but never turn an after-send 5xx into a retry (spec 14.5, 20.4 R8).
 */
export function classifyByStatus(input: {
  status?: number;
  body?: string;
  phase: 'before_send' | 'after_send';
  error?: unknown;
}): ProviderErrorClass {
  if (input.error instanceof ProviderTransportError) {
    if (input.error.phase === 'before_send')
      return { kind: 'rate_limited', phase: 'before_send', retryAfterMs: 5_000 };
    return { kind: 'unknown' };
  }
  const s = input.status;
  if (s === undefined) return { kind: 'unknown' };
  if (s === 401) return { kind: 'refresh_token' };
  if (s === 403) return { kind: 'reconnect_required' };
  if (s === 429)
    return input.phase === 'before_send'
      ? { kind: 'rate_limited', phase: 'before_send' }
      : { kind: 'unknown' };
  if (s >= 400 && s < 500) return { kind: 'rejected', code: `http_${s}` };
  return { kind: 'unknown' };
}

/** Maps a classification of a publish call to the outcome the workflow understands. */
export function outcomeFromClass(cls: ProviderErrorClass, message: string): PublishOutcome {
  switch (cls.kind) {
    case 'rejected':
      return { outcome: 'rejected', code: cls.code, message };
    case 'rate_limited':
      return { outcome: 'retryable_error', code: 'rate_limited', message, retryAfterMs: cls.retryAfterMs };
    case 'refresh_token':
      return { outcome: 'retryable_error', code: 'refresh_token', message };
    case 'reconnect_required':
      return { outcome: 'rejected', code: 'reconnect_required', message };
    case 'unknown':
      return { outcome: 'unknown', code: 'ambiguous', message };
  }
}

/** Retry-After header in ms, bounded. */
export function retryAfterMs(
  headerValue: string | null | undefined,
  fallbackMs = 5_000,
  maxMs = 15 * 60_000,
): number {
  if (!headerValue) return fallbackMs;
  const secs = Number(headerValue);
  if (Number.isFinite(secs)) return Math.min(maxMs, Math.max(1000, secs * 1000));
  const at = Date.parse(headerValue);
  if (Number.isFinite(at)) return Math.min(maxMs, Math.max(1000, at - Date.now()));
  return fallbackMs;
}

/** Spec 20.2: missing OAuth scopes are surfaced before a channel is usable. */
export function missingScopes(required: readonly string[], granted: readonly string[]): string[] {
  const g = new Set(granted.map((s) => s.toLowerCase()));
  return required.filter((r) => !g.has(r.toLowerCase()));
}
