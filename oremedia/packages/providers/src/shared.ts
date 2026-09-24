import { createHash } from 'node:crypto';
import type {
  ChannelVariantInput,
  PendingCheck,
  ProviderErrorClass,
  PublishOutcome,
  RawMetricPoint,
  ReconcileResult,
  ValidationResult,
} from '@oremedia/contracts/providers';
import { outcomeFromClass, redactBody, retryAfterMs, truncateForTemporal } from './base';
import { ProviderTransportError, type ProviderIO } from './io';

/*
 * Helpers shared by every adapter. Nothing here knows a platform: platform specifics live in the adapter
 * directories (spec 2.2, CLAUDE.md "generic code never branches on a provider").
 */

/** The response ProviderIO hands back. Adapters never import undici themselves (lint rule). */
export type IOResponse = Awaited<ReturnType<ProviderIO['request']>>['res'];

export interface ProviderResponse {
  status: number;
  headers: IOResponse['headers'];
  body: string;
  json: unknown;
}

/** Reads a response once: raw text plus a JSON parse when the body is JSON. */
export async function readResponse(res: IOResponse): Promise<ProviderResponse> {
  const body = await res.text();
  let json: unknown;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, body, json };
}

/**
 * The same algorithm as `hashText` in @oremedia/domain (spec 13.2: NFC, trailing whitespace trimmed, SHA-256 hex).
 * Providers may not depend on domain (spec 3.3), so the fingerprint a publication attempt records and the one an
 * adapter derives from a remote post are computed by the same three lines here.
 */
export const textFingerprint = (text: string): string =>
  createHash('sha256').update(text.normalize('NFC').replace(/\s+$/u, '')).digest('hex');
export const matchesFingerprint = (remoteText: unknown, fingerprint: string): boolean =>
  typeof remoteText === 'string' && textFingerprint(remoteText) === fingerprint;

/** Safe getters over untyped JSON. */
export const get = (value: unknown, ...path: Array<string | number>): unknown => {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
};
export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
export const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Sums a number or a breakdown object ({ paid: 1, organic: 2 }); undefined when neither. */
export const sumValue = (v: unknown): number | undefined => {
  const n = num(v);
  if (n !== undefined) return n;
  if (v && typeof v === 'object' && !Array.isArray(v))
    return Object.values(v as Record<string, unknown>).reduce<number>((s, x) => s + (num(x) ?? 0), 0);
  return undefined;
};

/** A user-safe, truncated, redacted summary of a provider response for outcomes and logs. */
export const summarise = (res: ProviderResponse, limit = 600): string =>
  truncateForTemporal(redactBody(res.body || `HTTP ${res.status}`), limit);

export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });
export const formEncode = (params: Record<string, string>): string => new URLSearchParams(params).toString();
export const expiresAtFrom = (expiresInSec: number | undefined, now = Date.now()): string | undefined =>
  expiresInSec && expiresInSec > 0 ? new Date(now + expiresInSec * 1000).toISOString() : undefined;
export const unixSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

/**
 * Spec 14.3: the request that creates the public post is the effect boundary. Failures before it was sent cannot
 * have published anything (uploads and container registrations leave at most orphaned media, which the platform
 * expires), so they hand the publication back as `retryable_error`. Failures at or after it follow the strict
 * rule: a before_send transport error is retryable, everything else is ambiguous and becomes `unknown`.
 */
export class EffectBoundary {
  private crossed = false;
  /** Call immediately before sending the post-creating mutation. */
  cross(): void {
    this.crossed = true;
  }
  get isCrossed(): boolean {
    return this.crossed;
  }
}

export type Classifier = (input: {
  status?: number;
  body?: string;
  phase: 'before_send' | 'after_send';
  error?: unknown;
}) => ProviderErrorClass;

/** Thrown when a signed media URL (spec 9.3) cannot be read; always before the effect boundary. */
export class MediaFetchError extends Error {
  readonly status: number;
  constructor(url: string, status: number) {
    super(`media fetch failed with HTTP ${status}: ${new URL(url).pathname}`);
    this.name = 'MediaFetchError';
    this.status = status;
  }
}

/** Fetches media bytes through ProviderIO so the SSRF policy, timeout and logging apply to release URLs too. */
export async function fetchBytes(io: ProviderIO, url: string): Promise<Uint8Array> {
  const { res } = await io.request(url, { method: 'GET' }, { mutation: false });
  if (res.status !== 200) throw new MediaFetchError(url, res.status);
  return new Uint8Array(await res.arrayBuffer());
}

export function outcomeFromTransportError(
  err: unknown,
  boundary: EffectBoundary,
): PublishOutcome | undefined {
  if (err instanceof MediaFetchError)
    return { outcome: 'retryable_error', code: 'media_fetch_failed', message: err.message };
  if (!(err instanceof ProviderTransportError)) return undefined;
  const message = truncateForTemporal(err.message, 300);
  if (!boundary.isCrossed) return { outcome: 'retryable_error', code: 'transport_before_publish', message };
  if (err.phase === 'before_send')
    return { outcome: 'retryable_error', code: 'transport_before_send', message };
  return { outcome: 'unknown', code: 'transport_after_send', message };
}

/**
 * Maps a non-2xx response to an outcome. Before the boundary an unclassifiable failure (5xx) is retryable because
 * nothing public can exist yet; after it, the adapter's classification stands (spec 14.5, 20.4 R8).
 * `retryAfter` lets an adapter read its platform's rate-limit headers.
 */
export function outcomeFromResponse(
  classify: Classifier,
  res: ProviderResponse,
  boundary: EffectBoundary,
  retryAfter?: (headers: IOResponse['headers']) => number | undefined,
): PublishOutcome {
  const cls = classify({ status: res.status, body: res.body, phase: 'after_send' });
  if (cls.kind === 'rate_limited' && cls.retryAfterMs === undefined)
    return outcomeFromClass(
      {
        ...cls,
        retryAfterMs: retryAfter?.(res.headers) ?? retryAfterMs(res.headers.get('retry-after'), 60_000),
      },
      summarise(res),
    );
  if (!boundary.isCrossed && cls.kind === 'unknown')
    return { outcome: 'retryable_error', code: `pre_publish_http_${res.status}`, message: summarise(res) };
  return outcomeFromClass(cls, summarise(res));
}

/** Runs a publish flow, mapping transport errors to outcomes; anything else is a bug and propagates. */
export async function runPublish(
  boundary: EffectBoundary,
  fn: () => Promise<PublishOutcome>,
): Promise<PublishOutcome> {
  try {
    return await fn();
  } catch (err) {
    const outcome = outcomeFromTransportError(err, boundary);
    if (outcome) return outcome;
    throw err;
  }
}

/**
 * Thrown by `finalize` when the finalising mutation was sent and its result is ambiguous (timeout, reset, 5xx).
 * PendingCheck has no `unknown` member: the caller treats a thrown error as `unknown` and reconciles with
 * `findRemotePost` (spec 14.3). Never caught and retried inside the adapter.
 */
export class AmbiguousMutationError extends Error {
  readonly status: number | undefined;
  readonly phase = 'after_send' as const;
  constructor(message: string, status?: number, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AmbiguousMutationError';
    this.status = status;
  }
}

/** Read-only status polling: a transport failure is never fatal, the workflow polls again. */
export async function runCheck(
  fn: () => Promise<PendingCheck>,
  retryAfterMs = 30_000,
): Promise<PendingCheck> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderTransportError) return { status: 'processing', retryAfterMs };
    throw err;
  }
}

/** Finalise: a before_send transport error means the mutation never left, poll again; after_send is ambiguous. */
export async function runFinalize(fn: () => Promise<PendingCheck>): Promise<PendingCheck> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderTransportError) {
      if (err.phase === 'before_send') return { status: 'processing', retryAfterMs: 15_000 };
      throw new AmbiguousMutationError(err.message, undefined, err);
    }
    throw err;
  }
}

/** Maps an HTTP failure of a read during checkStatus: definitive problems fail, throttles and 5xx poll again. */
export function checkFailure(classify: Classifier, res: ProviderResponse): PendingCheck {
  const cls = classify({ status: res.status, body: res.body, phase: 'after_send' });
  switch (cls.kind) {
    case 'rejected':
      return { status: 'failed', code: cls.code, message: summarise(res) };
    case 'refresh_token':
    case 'reconnect_required':
      return { status: 'failed', code: cls.kind, message: summarise(res) };
    case 'rate_limited':
      return {
        status: 'processing',
        retryAfterMs: cls.retryAfterMs ?? retryAfterMs(res.headers.get('retry-after'), 60_000),
      };
    case 'unknown':
      return { status: 'processing', retryAfterMs: 30_000 };
  }
}

/** Maps an HTTP failure of the finalising mutation: 429 is documented as not executed on every Release 1 platform; 5xx is ambiguous. */
export function finalizeFailure(classify: Classifier, res: ProviderResponse): PendingCheck {
  const cls = classify({ status: res.status, body: res.body, phase: 'after_send' });
  switch (cls.kind) {
    case 'rejected':
      return { status: 'failed', code: cls.code, message: summarise(res) };
    case 'refresh_token':
    case 'reconnect_required':
      return { status: 'failed', code: cls.kind, message: summarise(res) };
    case 'rate_limited':
      return {
        status: 'processing',
        retryAfterMs: cls.retryAfterMs ?? retryAfterMs(res.headers.get('retry-after'), 60_000),
      };
    case 'unknown':
      throw new AmbiguousMutationError(
        `finalise returned HTTP ${res.status}: ${summarise(res, 200)}`,
        res.status,
      );
  }
}

/** A recent remote post as every adapter's scan normalises it. */
export interface RecentPost {
  id: string;
  text: string | undefined;
  createdAt: number | undefined;
  url: string;
}

/** Clock skew tolerated between Oremedia's attempt clock and the platform's creation timestamp. */
export const RECONCILE_SKEW_MS = 5 * 60_000;

export function matchRecent(
  posts: readonly RecentPost[],
  req: { attemptStartedAt: Date; textFingerprint: string },
): RecentPost | undefined {
  const notBefore = req.attemptStartedAt.getTime() - RECONCILE_SKEW_MS;
  return posts.find(
    (p) =>
      (p.createdAt === undefined || p.createdAt >= notBefore) &&
      matchesFingerprint(p.text, req.textFingerprint),
  );
}

/**
 * Spec 14.3 reconciliation outcomes: `found` with evidence, `definitely_absent` only when the scan provably covers
 * the attempt window, otherwise `cannot_determine`.
 */
export function reconcileFromScan(
  scan: { posts: readonly RecentPost[]; covered: boolean; reason?: string },
  req: { attemptStartedAt: Date; textFingerprint: string },
): ReconcileResult {
  const match = matchRecent(scan.posts, req);
  if (match)
    return { status: 'found', remotePostId: match.id, remoteUrl: match.url, matchedBy: 'fingerprint' };
  if (scan.covered) return { status: 'definitely_absent' };
  return { status: 'cannot_determine', reason: scan.reason ?? 'scan_window_not_covered' };
}

/** Alt text policy (spec 21.3): when the variant asks for it, every image needs alt text; platforms cap its length. */
export function altTextIssues(variant: ChannelVariantInput, maxLength: number): ValidationResult['issues'] {
  const issues: ValidationResult['issues'] = [];
  const required = variant.settings['requireAltText'] === true;
  variant.media.forEach((m, i) => {
    const alt = variant.altTexts[i] ?? '';
    if (alt.length > maxLength)
      issues.push({ path: `altTexts.${i}`, issue: `alt_text_too_long:${alt.length}>${maxLength}` });
    if (required && m.mime.startsWith('image/') && alt.trim() === '')
      issues.push({ path: `altTexts.${i}`, issue: 'alt_text_missing' });
  });
  return issues;
}

export const withIssues = (base: ValidationResult, extra: ValidationResult['issues']): ValidationResult => ({
  ok: base.ok && extra.length === 0,
  issues: [...base.issues, ...extra],
});

/** Spec 15.1: unavailable is a row with no value, never zero. */
export const metricPoint = (
  nativeName: string,
  value: number | undefined,
  window: { start: string; end: string },
  extra: Partial<Pick<RawMetricPoint, 'unit' | 'series' | 'completeness'>> = {},
): RawMetricPoint => ({
  nativeName,
  value: value ?? null,
  unit: extra.unit ?? 'count',
  windowStart: window.start,
  windowEnd: window.end,
  completeness: extra.completeness ?? (value === undefined ? 'unavailable' : 'complete'),
  ...(extra.series ? { series: extra.series } : {}),
});

/** Raised by exchangeCode/selectAccount when a grant cannot be completed; the connect flow shows `code`. */
export class ProviderAuthError extends Error {
  readonly providerKey: string;
  readonly code: 'exchange_failed' | 'identity_failed' | 'no_eligible_account' | 'account_not_found';
  constructor(providerKey: string, code: ProviderAuthError['code'], detail: string) {
    super(`${providerKey} ${code}: ${truncateForTemporal(redactBody(detail), 300)}`);
    this.name = 'ProviderAuthError';
    this.providerKey = providerKey;
    this.code = code;
  }
}

/** Encodes a multipart/form-data body as bytes (undici's fetch does not accept Node's global FormData). */
export function multipart(
  parts: Array<{ name: string; value: string | Uint8Array; filename?: string; contentType?: string }>,
): { body: Uint8Array; contentType: string } {
  const boundary = `----oremedia${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 24)}`;
  const chunks: Uint8Array[] = [];
  const text = (s: string): Uint8Array => new TextEncoder().encode(s);
  for (const p of parts) {
    const disposition = `Content-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ''}`;
    const type = p.contentType ? `\r\nContent-Type: ${p.contentType}` : '';
    chunks.push(text(`--${boundary}\r\n${disposition}${type}\r\n\r\n`));
    chunks.push(typeof p.value === 'string' ? text(p.value) : p.value);
    chunks.push(text('\r\n'));
  }
  chunks.push(text(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
