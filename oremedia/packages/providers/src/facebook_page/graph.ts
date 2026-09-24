import type {
  AccountGrant,
  ClientConfig,
  ProviderErrorClass,
  RefreshResult,
} from '@oremedia/contracts/providers';
import { classifyByStatus } from '../base';
import { ProviderTransportError, type ProviderIO } from '../io';
import {
  arr,
  bearer,
  expiresAtFrom,
  formEncode,
  get,
  num,
  readResponse,
  str,
  summarise,
  type IOResponse,
  type ProviderResponse,
} from '../shared';

/*
 * Meta Graph API primitives shared by the Facebook Page adapter and the Instagram Business adapter, which
 * publishes through the same Graph API with Facebook Login (spec 14.8 "Instagram Business via Facebook Graph").
 * The version pin is re-derived at certification: Meta retires versions about two years after release.
 */
export const META_GRAPH_VERSION = 'v25.0';
export const META_GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
export const META_DIALOG = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;

export function metaAuthorizationUrl(input: {
  client: ClientConfig;
  redirectUri: string;
  state: string;
  scopes: readonly string[];
}): string {
  // Facebook Login's server-side flow has no PKCE parameter; the codeVerifier from the contract is unused.
  const u = new URL(META_DIALOG);
  u.searchParams.set('client_id', input.client.clientId);
  u.searchParams.set('redirect_uri', input.redirectUri);
  u.searchParams.set('state', input.state);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', input.scopes.join(','));
  return u.toString();
}

export async function graphGet(
  io: ProviderIO,
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<ProviderResponse> {
  const u = new URL(path.startsWith('https://') ? path : `${META_GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const { res } = await io.request(
    u.toString(),
    { method: 'GET', headers: bearer(token) },
    { mutation: false },
  );
  return readResponse(res);
}

export async function graphPost(
  io: ProviderIO,
  path: string,
  token: string,
  body: Record<string, unknown>,
  mutation = true,
): Promise<ProviderResponse> {
  const { res } = await io.request(
    `${META_GRAPH}${path}`,
    {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { mutation },
  );
  return readResponse(res);
}

/** Query-string oauth call; ProviderIO logs only the path, never the secret-bearing query. */
async function oauthAccessToken(io: ProviderIO, params: Record<string, string>): Promise<ProviderResponse> {
  const { res } = await io.request(
    `${META_GRAPH}/oauth/access_token?${formEncode(params)}`,
    { method: 'GET' },
    { mutation: false },
  );
  return readResponse(res);
}

export interface MetaUserToken {
  accessToken: string;
  expiresAt: string | undefined;
  grantedScopes: string[];
  userId: string;
  userName: string;
}

/** Code → short-lived token → long-lived token (60 days) → granted permissions → identity. Throws on failure. */
export async function metaExchangeCode(
  input: { code: string; redirectUri: string; client: ClientConfig },
  io: ProviderIO,
  fail: (code: 'exchange_failed' | 'identity_failed', detail: string) => never,
): Promise<MetaUserToken> {
  const short = await oauthAccessToken(io, {
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  const shortToken = str(get(short.json, 'access_token'));
  if (short.status !== 200 || !shortToken) return fail('exchange_failed', summarise(short));
  const long = await metaExtendToken(shortToken, input.client, io);
  const accessToken = str(get(long.json, 'access_token'));
  if (long.status !== 200 || !accessToken) return fail('exchange_failed', summarise(long));
  const perms = await graphGet(io, '/me/permissions', accessToken);
  if (perms.status !== 200) return fail('identity_failed', summarise(perms));
  const grantedScopes = arr(get(perms.json, 'data'))
    .filter((p) => get(p, 'status') === 'granted')
    .map((p) => str(get(p, 'permission')) ?? '')
    .filter(Boolean);
  const me = await graphGet(io, '/me', accessToken, { fields: 'id,name' });
  const userId = str(get(me.json, 'id'));
  if (me.status !== 200 || !userId) return fail('identity_failed', summarise(me));
  return {
    accessToken,
    expiresAt: expiresAtFrom(num(get(long.json, 'expires_in'))),
    grantedScopes,
    userId,
    userName: str(get(me.json, 'name')) ?? userId,
  };
}

/** fb_exchange_token: also how a still-valid long-lived user token is renewed (verified at certification). */
export function metaExtendToken(
  userToken: string,
  client: ClientConfig,
  io: ProviderIO,
): Promise<ProviderResponse> {
  return oauthAccessToken(io, {
    grant_type: 'fb_exchange_token',
    client_id: client.clientId,
    client_secret: client.clientSecret,
    fb_exchange_token: userToken,
  });
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  igAccountId?: string;
  igUsername?: string;
}

/** Pages the user administers, with page tokens and any connected Instagram professional account. Follows paging.next (bounded). */
export async function listPages(io: ProviderIO, userToken: string): Promise<MetaPage[]> {
  const pages: MetaPage[] = [];
  let next: string | undefined = `${META_GRAPH}/me/accounts`;
  let params: Record<string, string> | undefined = {
    fields: 'id,name,access_token,instagram_business_account{id,username}',
    limit: '100',
  };
  for (let i = 0; i < 5 && next; i += 1) {
    const res: ProviderResponse = await graphGet(io, next, userToken, params);
    if (res.status !== 200) throw new MetaGraphError('me/accounts', res);
    for (const p of arr(get(res.json, 'data'))) {
      const id = str(get(p, 'id'));
      const accessToken = str(get(p, 'access_token'));
      if (!id || !accessToken) continue;
      const igId = str(get(p, 'instagram_business_account', 'id'));
      pages.push({
        id,
        name: str(get(p, 'name')) ?? id,
        accessToken,
        ...(igId ? { igAccountId: igId } : {}),
        ...(str(get(p, 'instagram_business_account', 'username'))
          ? { igUsername: str(get(p, 'instagram_business_account', 'username')) }
          : {}),
      });
    }
    next = str(get(res.json, 'paging', 'next'));
    params = undefined;
  }
  return pages.sort((a, b) => a.id.localeCompare(b.id));
}

export class MetaGraphError extends Error {
  readonly status: number;
  constructor(op: string, res: ProviderResponse) {
    super(`meta ${op} failed: ${summarise(res, 300)}`);
    this.name = 'MetaGraphError';
    this.status = res.status;
  }
}

export interface MetaErrorBody {
  code?: number;
  subcode?: number;
  type?: string;
  message?: string;
}

export function metaError(body: string | undefined): MetaErrorBody {
  if (!body) return {};
  try {
    const e = get(JSON.parse(body), 'error');
    return {
      code: num(get(e, 'code')),
      subcode: num(get(e, 'error_subcode')),
      type: str(get(e, 'type')),
      message: str(get(e, 'message')),
    };
  } catch {
    return {};
  }
}

const THROTTLE_CODES = new Set([4, 17, 32, 613]);
const RECONNECT_190_SUBCODES = new Set([458, 459, 460, 464, 467]);

/**
 * Meta error taxonomy: code 190 is the token (463 expired → refresh; the others need a new grant), 10 and
 * 200–299 are permissions, 4/17/32/613/8000x are throttles (documented as not executed), 1 and 2 are transient
 * platform errors (ambiguous after a mutation), everything else 4xx is a definitive rejection.
 */
export function classifyMetaError(input: {
  status?: number;
  body?: string;
  phase: 'before_send' | 'after_send';
  error?: unknown;
}): ProviderErrorClass {
  if (input.error instanceof ProviderTransportError || input.status === undefined)
    return classifyByStatus(input);
  const e = metaError(input.body);
  const status = input.status;
  if (e.code === 190)
    return e.subcode === 463
      ? { kind: 'refresh_token' }
      : RECONNECT_190_SUBCODES.has(e.subcode ?? -1)
        ? { kind: 'reconnect_required' }
        : { kind: 'reconnect_required' };
  if (e.code === 102) return { kind: 'reconnect_required' };
  if (e.code === 10 || (e.code !== undefined && e.code >= 200 && e.code <= 299))
    return { kind: 'reconnect_required' };
  if (
    (e.code !== undefined && THROTTLE_CODES.has(e.code)) ||
    (e.code !== undefined && e.code >= 80000 && e.code < 80010) ||
    status === 429
  )
    return { kind: 'rate_limited', phase: 'before_send' };
  if (e.code === 1 || e.code === 2) return { kind: 'unknown' };
  if (status === 401) return { kind: 'refresh_token' };
  if (status === 403) return { kind: 'reconnect_required' };
  if (status >= 400 && status < 500)
    return { kind: 'rejected', code: `meta_${e.code ?? status}${e.subcode ? `_${e.subcode}` : ''}` };
  return { kind: 'unknown' };
}

/** Meta sends no Retry-After; the business-use-case usage header carries minutes until access is regained. */
export function metaRetryAfterMs(headers: IOResponse['headers']): number | undefined {
  for (const name of ['x-business-use-case-usage', 'x-app-usage']) {
    const raw = headers.get(name);
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const entries = Array.isArray(parsed)
        ? parsed
        : Object.values(parsed as Record<string, unknown>).flat();
      for (const entry of entries) {
        const minutes = num(get(entry, 'estimated_time_to_regain_access'));
        if (minutes !== undefined && minutes > 0) return Math.min(15 * 60_000, minutes * 60_000);
      }
    } catch {
      // ignore an unparsable usage header
    }
  }
  return undefined;
}

export function metaRefreshFailure(res: ProviderResponse): RefreshResult {
  const cls = classifyMetaError({ status: res.status, body: res.body, phase: 'after_send' });
  return {
    ok: false,
    reason: cls.kind === 'unknown' || cls.kind === 'rate_limited' ? 'transient' : 'reconnect_required',
  };
}

export const alternativesFrom = (
  pages: readonly { id: string; name: string }[],
  chosen: string,
): AccountGrant['alternatives'] =>
  pages.filter((p) => p.id !== chosen).map((p) => ({ remoteAccountId: p.id, displayName: p.name }));
