import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { authenticate, hashForAudit, type Principal } from '@oremedia/module-access';
import { withLogContext } from '@oremedia/observability';

export interface RequestContext {
  correlationId: string;
  principal: Principal | null;
  requestedTenantId: string | undefined;
  headers: IncomingHttpHeaders;
  /** Cookie-based browser sessions must present a matching CSRF header on mutations (spec 18). */
  csrf: { cookie: string | undefined; header: string | undefined };
  /** Set only when authentication came from a cookie rather than a bearer header. */
  cookieSession: boolean;
  /** Spec 5.6: review decisions record the origin as salted hashes, never the raw IP or user agent. */
  ipHash: string | null;
  userAgentHash: string | null;
}

export const SESSION_COOKIE = 'oremedia_session';
export const CSRF_COOKIE = 'oremedia_csrf';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function firstHeader(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

/** A client-supplied correlation id is echoed into logs and audit rows, so only a safe charset is accepted. */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Salt for origin hashes (AUDIT_HASH_SALT); absent, hashes are still one-way but not keyed. */
const originSalt = () => process.env['AUDIT_HASH_SALT'] ?? 'oremedia';

/** Builds the request context from raw headers; the same function serves HTTP and in-process test callers. */
export async function createContext(
  headers: IncomingHttpHeaders,
  remoteAddress?: string,
): Promise<RequestContext> {
  const requestedCorrelationId = firstHeader(headers['x-correlation-id']);
  const correlationId =
    requestedCorrelationId && CORRELATION_ID.test(requestedCorrelationId)
      ? requestedCorrelationId
      : randomUUID();
  const cookies = parseCookies(firstHeader(headers['cookie']));
  const auth = firstHeader(headers['authorization']);
  let bearer: string | undefined;
  let cookieSession = false;
  if (auth?.startsWith('Bearer ')) bearer = auth.slice(7).trim();
  else if (cookies[SESSION_COOKIE]) {
    bearer = cookies[SESSION_COOKIE];
    cookieSession = true;
  }
  const principal = await withLogContext({ correlationId }, () => authenticate(bearer));
  return {
    correlationId,
    principal,
    requestedTenantId: firstHeader(headers['x-oremedia-tenant'])?.slice(0, 32),
    headers,
    csrf: { cookie: cookies[CSRF_COOKIE], header: firstHeader(headers['x-oremedia-csrf']) },
    cookieSession,
    ipHash: remoteAddress ? hashForAudit(remoteAddress, originSalt()) : null,
    userAgentHash: headers['user-agent'] ? hashForAudit(String(headers['user-agent']), originSalt()) : null,
  };
}
