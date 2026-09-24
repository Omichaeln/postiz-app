import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  AccountGrant,
  ChannelVariantInput,
  ClientConfig,
  CommentPage,
  DecryptedCredentials,
  MetricWindow,
  PendingCheck,
  PendingState,
  ProviderErrorClass,
  PublishOutcome,
  RawMetricPoint,
  ReconcileResult,
  RefreshResult,
  ValidationResult,
} from '@oremedia/contracts/providers';
import type { CommentRequest, ProviderAdapter, PublishMedia, PublishRequest } from '../contract';
import { ProviderTransportError, type ProviderIO } from '../io';
import { classifyByStatus } from '../base';
import { validateVariantAgainstCapability } from '../capability';
import {
  EffectBoundary,
  ProviderAuthError,
  altTextIssues,
  arr,
  bearer,
  checkFailure,
  expiresAtFrom,
  fetchBytes,
  finalizeFailure,
  formEncode,
  get,
  metricPoint,
  multipart,
  num,
  outcomeFromResponse,
  readResponse,
  reconcileFromScan,
  runCheck,
  runFinalize,
  runPublish,
  str,
  summarise,
  withIssues,
  type IOResponse,
  type ProviderResponse,
  type RecentPost,
} from '../shared';
import { xCapability } from './capability';
import { measureX } from './text';

export const X_API = 'https://api.x.com/2';
export const X_AUTHORIZE = 'https://x.com/i/oauth2/authorize';
const CHUNK_BYTES = 1024 * 1024; // proven APPEND segment size; X documents up to 5 MB
const GIF_MAX_BYTES = 15 * 1024 * 1024;
const ALT_TEXT_MAX = 1000;

const PendingData = z.object({
  v: z.literal(1),
  userId: z.string(),
  username: z.string().optional(),
  text: z.string(),
  mediaIds: z.array(z.string()),
  processingIds: z.array(z.string()),
  replySettings: z.string().optional(),
  textFingerprint: z.string(),
  attemptStartedAt: z.string(),
});
type PendingData = z.infer<typeof PendingData>;

const tweetUrl = (username: string | undefined, id: string): string =>
  username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/web/status/${id}`;
const pkceChallenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

/**
 * X adapter (spec 14.5, 14.8): OAuth 2.0 PKCE with rotating refresh tokens; chunked media upload (INIT/APPEND/
 * FINALIZE, STATUS polling for video); POST /2/tweets is the effect boundary. Weighted text counting is in
 * ./text.ts. The spec 20.3 invariant and reconciliation scan the user's recent posts by text fingerprint,
 * reconstructing original URLs from `entities.urls` because X rewrites links to t.co.
 */
export class XAdapter implements ProviderAdapter {
  readonly key = 'x';
  readonly capability = xCapability;

  async authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    client: ClientConfig;
  }): Promise<{ url: string }> {
    const u = new URL(X_AUTHORIZE);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', input.client.clientId);
    u.searchParams.set('redirect_uri', input.redirectUri);
    u.searchParams.set('scope', this.capability.requiredScopes.join(' '));
    u.searchParams.set('state', input.state);
    u.searchParams.set('code_challenge', pkceChallenge(input.codeVerifier));
    u.searchParams.set('code_challenge_method', 'S256');
    return { url: u.toString() };
  }

  async exchangeCode(
    input: { code: string; codeVerifier: string; redirectUri: string; client: ClientConfig },
    io: ProviderIO,
  ): Promise<AccountGrant> {
    const token = await this.tokenRequest(io, input.client, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      client_id: input.client.clientId,
    });
    const accessToken = str(get(token.json, 'access_token'));
    if (token.status !== 200 || !accessToken)
      throw new ProviderAuthError(this.key, 'exchange_failed', summarise(token));
    const me = await this.api(io, 'GET', '/users/me?user.fields=username,name', accessToken);
    const userId = str(get(me.json, 'data', 'id'));
    if (me.status !== 200 || !userId) throw new ProviderAuthError(this.key, 'identity_failed', summarise(me));
    const username = str(get(me.json, 'data', 'username'));
    const expiresAt = expiresAtFrom(num(get(token.json, 'expires_in')));
    const refreshToken = str(get(token.json, 'refresh_token'));
    return {
      remoteAccountId: userId,
      displayName: str(get(me.json, 'data', 'name')) ?? username ?? userId,
      grantedScopes: (str(get(token.json, 'scope')) ?? '').split(/\s+/).filter(Boolean),
      credentials: {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        extra: { ...(username ? { username } : {}) },
      },
      ...(expiresAt ? { tokenExpiresAt: expiresAt } : {}),
    };
  }

  async refresh(
    credentials: DecryptedCredentials,
    client: ClientConfig,
    io: ProviderIO,
  ): Promise<RefreshResult> {
    if (!credentials.refreshToken) return { ok: false, reason: 'reconnect_required' };
    let res: ProviderResponse;
    try {
      res = await this.tokenRequest(io, client, {
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: client.clientId,
      });
    } catch (err) {
      if (err instanceof ProviderTransportError) return { ok: false, reason: 'transient' };
      throw err;
    }
    const accessToken = str(get(res.json, 'access_token'));
    if (res.status === 200 && accessToken) {
      const expiresAt = expiresAtFrom(num(get(res.json, 'expires_in')));
      // Refresh tokens rotate: the returned one replaces the stored one, the old one is spent.
      return {
        ok: true,
        credentials: {
          ...credentials,
          accessToken,
          refreshToken: str(get(res.json, 'refresh_token')) ?? credentials.refreshToken,
          ...(expiresAt ? { expiresAt } : {}),
        },
        ...(expiresAt ? { tokenExpiresAt: expiresAt } : {}),
      };
    }
    return { ok: false, reason: res.status >= 400 && res.status < 500 ? 'reconnect_required' : 'transient' };
  }

  validateVariant(variant: ChannelVariantInput): ValidationResult {
    const base = validateVariantAgainstCapability(this.capability, variant, measureX);
    const extra: ValidationResult['issues'] = altTextIssues(variant, ALT_TEXT_MAX);
    const videos = variant.media.filter((m) => m.mime.startsWith('video/')).length;
    const gifs = variant.media.filter((m) => m.mime === 'image/gif').length;
    if (videos > 1) extra.push({ path: 'media', issue: 'multiple_videos_not_supported' });
    if (videos > 0 && variant.media.length > videos)
      extra.push({ path: 'media', issue: 'mixed_media_not_supported' });
    if (gifs > 0 && variant.media.length > 1) extra.push({ path: 'media', issue: 'gif_must_be_alone' });
    variant.media.forEach((m, i) => {
      if (m.mime === 'image/gif' && m.bytes > GIF_MAX_BYTES)
        extra.push({ path: `media.${i}`, issue: 'gif_too_large' });
    });
    // GIFs have their own 15 MB cap: drop the generic 5 MB verdict for them (checked above).
    const issues = base.issues.filter(
      (i) =>
        !(
          i.issue === 'image_too_large' && variant.media[Number(i.path?.split('.')[1])]?.mime === 'image/gif'
        ),
    );
    return withIssues({ ok: issues.length === 0, issues }, extra);
  }

  measureText(text: string): { length: number; limit: number } {
    return measureX(text);
  }

  async publish(req: PublishRequest, creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome> {
    const boundary = new EffectBoundary();
    return runPublish(boundary, async () => {
      const mediaIds: string[] = [];
      const processingIds: string[] = [];
      for (const m of req.media) {
        const up = await this.uploadMedia(io, creds.accessToken, m, boundary);
        if (typeof up !== 'string' && 'outcome' in up) return up;
        mediaIds.push(up.id);
        if (up.processing) processingIds.push(up.id);
      }
      const replySettings = str(req.settings['replySettings']);
      const username = creds.extra?.['username'];
      if (processingIds.length === 0)
        return this.createTweet(
          io,
          creds.accessToken,
          { text: req.text, mediaIds, replySettings, username },
          boundary,
        );
      const data: PendingData = {
        v: 1,
        userId: req.remoteAccountId,
        ...(username ? { username } : {}),
        text: req.text,
        mediaIds,
        processingIds,
        ...(replySettings ? { replySettings } : {}),
        textFingerprint: req.textFingerprint,
        attemptStartedAt: new Date().toISOString(),
      };
      return {
        outcome: 'pending',
        pending: { remoteJobId: processingIds[0], data },
        remoteJobId: processingIds[0],
      };
    });
  }

  async checkStatus(
    pending: PendingState,
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<PendingCheck> {
    const parsed = PendingData.safeParse(pending.data);
    if (!parsed.success)
      return { status: 'failed', code: 'pending_state_invalid', message: parsed.error.message };
    const data = parsed.data;
    return runCheck(async () => {
      const done = await this.completedPost(io, creds.accessToken, data); // spec 20.3
      if (done) return done;
      let retryAfterMs = 5_000;
      for (const id of data.processingIds) {
        const res = await this.api(
          io,
          'GET',
          `/media/upload?command=STATUS&media_id=${encodeURIComponent(id)}`,
          creds.accessToken,
        );
        if (res.status !== 200) return checkFailure((i) => this.classifyError(i), res);
        const info = get(res.json, 'data', 'processing_info');
        const state = str(get(info, 'state'));
        if (state === 'failed')
          return {
            status: 'failed',
            code: 'media_processing_failed',
            message: str(get(info, 'error', 'message')) ?? id,
          };
        if (info !== undefined && state !== 'succeeded')
          retryAfterMs = Math.max(retryAfterMs, (num(get(info, 'check_after_secs')) ?? 5) * 1000);
        if (info !== undefined && state !== 'succeeded') return { status: 'processing', retryAfterMs };
      }
      return { status: 'ready' };
    });
  }

  async finalize(pending: PendingState, creds: DecryptedCredentials, io: ProviderIO): Promise<PendingCheck> {
    const parsed = PendingData.safeParse(pending.data);
    if (!parsed.success)
      return { status: 'failed', code: 'pending_state_invalid', message: parsed.error.message };
    const data = parsed.data;
    return runFinalize(async () => {
      const res = await this.tweetsCreate(io, creds.accessToken, {
        text: data.text,
        mediaIds: data.mediaIds,
        replySettings: data.replySettings,
      });
      if (res.status === 201 || res.status === 200) {
        const id = str(get(res.json, 'data', 'id'));
        if (!id) return finalizeFailure((i) => this.classifyError(i), { ...res, status: 502 });
        return { status: 'completed', remotePostId: id, remoteUrl: tweetUrl(data.username, id) };
      }
      // Duplicate content means an earlier finalise went through: find it rather than fail.
      if (res.status === 403 && /duplicate/i.test(res.body)) {
        const done = await this.completedPost(io, creds.accessToken, data);
        if (done) return done;
      }
      return finalizeFailure((i) => this.classifyError(i), res);
    });
  }

  async comment(req: CommentRequest, creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome> {
    const boundary = new EffectBoundary();
    return runPublish(boundary, () =>
      this.createTweet(
        io,
        creds.accessToken,
        { text: req.text, mediaIds: [], inReplyTo: req.remotePostId, username: creds.extra?.['username'] },
        boundary,
      ),
    );
  }

  async findRemotePost(
    req: {
      publicationId: string;
      attemptStartedAt: Date;
      textFingerprint: string;
      mediaFingerprints: string[];
      remoteAccountId: string;
    },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<ReconcileResult> {
    try {
      return reconcileFromScan(
        await this.scanRecent(io, creds.accessToken, req.remoteAccountId, req.attemptStartedAt),
        req,
      );
    } catch (err) {
      if (err instanceof ProviderTransportError)
        return { status: 'cannot_determine', reason: `scan_transport_${err.phase}` };
      throw err;
    }
  }

  async fetchPostMetrics(
    req: { remotePostId: string; window: MetricWindow },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<RawMetricPoint[]> {
    const names = this.capability.analytics.post;
    let res = await this.api(
      io,
      'GET',
      `/tweets/${encodeURIComponent(req.remotePostId)}?tweet.fields=public_metrics,non_public_metrics`,
      creds.accessToken,
    );
    // non_public_metrics are refused for posts older than 30 days (and on some tiers): fall back to public only.
    if (res.status !== 200)
      res = await this.api(
        io,
        'GET',
        `/tweets/${encodeURIComponent(req.remotePostId)}?tweet.fields=public_metrics`,
        creds.accessToken,
      );
    if (res.status !== 200) return names.map((n) => metricPoint(n, undefined, req.window));
    const pub = get(res.json, 'data', 'public_metrics');
    const nonPub = get(res.json, 'data', 'non_public_metrics');
    return names.map((n) =>
      metricPoint(n, num(get(pub, n)) ?? num(get(nonPub, n)), req.window, { unit: 'lifetime_count' }),
    );
  }

  async fetchAccountMetrics(
    req: { remoteAccountId: string; window: MetricWindow },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<RawMetricPoint[]> {
    const names = this.capability.analytics.account;
    const res = await this.api(
      io,
      'GET',
      `/users/${encodeURIComponent(req.remoteAccountId)}?user.fields=public_metrics`,
      creds.accessToken,
    );
    if (res.status !== 200) return names.map((n) => metricPoint(n, undefined, req.window));
    const pm = get(res.json, 'data', 'public_metrics');
    return names.map((n) => metricPoint(n, num(get(pm, n)), req.window, { unit: 'snapshot_count' }));
  }

  async fetchComments(
    req: { remotePostId: string; since?: Date; cursor?: string },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<CommentPage> {
    const q = new URLSearchParams({
      query: `conversation_id:${req.remotePostId}`,
      'tweet.fields': 'created_at,author_id,referenced_tweets',
      expansions: 'author_id',
      'user.fields': 'username',
      max_results: '100',
      ...(req.cursor ? { next_token: req.cursor } : {}),
      ...(req.since ? { start_time: req.since.toISOString() } : {}),
    });
    const res = await this.api(io, 'GET', `/tweets/search/recent?${q.toString()}`, creds.accessToken);
    if (res.status !== 200) throw new Error(`x comments failed: ${summarise(res, 200)}`);
    const users = new Map(
      arr(get(res.json, 'includes', 'users')).map((u) => [
        str(get(u, 'id')) ?? '',
        str(get(u, 'username')) ?? '',
      ]),
    );
    const items = arr(get(res.json, 'data'))
      .map((t) => {
        const id = str(get(t, 'id')) ?? '';
        const parent = arr(get(t, 'referenced_tweets')).find((r) => get(r, 'type') === 'replied_to');
        return {
          remoteCommentId: id,
          authorHandle: users.get(str(get(t, 'author_id')) ?? '') ?? str(get(t, 'author_id')) ?? '',
          text: str(get(t, 'text')) ?? '',
          createdAt: new Date(str(get(t, 'created_at')) ?? 0).toISOString(),
          ...(str(get(parent, 'id')) ? { parentRemoteId: str(get(parent, 'id')) } : {}),
        };
      })
      .filter((c) => c.remoteCommentId && c.remoteCommentId !== req.remotePostId);
    const next = str(get(res.json, 'meta', 'next_token'));
    return { items, ...(next ? { nextCursor: next } : {}) };
  }

  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass {
    if (input.error instanceof ProviderTransportError || input.status === undefined)
      return classifyByStatus(input);
    const body = input.body ?? '';
    const s = input.status;
    if (s === 401) return { kind: 'refresh_token' };
    // X rate limits are enforced before the request is processed.
    if (s === 429) return { kind: 'rate_limited', phase: 'before_send' };
    if (s === 403) {
      if (/duplicate/i.test(body)) return { kind: 'rejected', code: 'duplicate_content' };
      if (/usage-capped|UsageCapExceeded/i.test(body)) return { kind: 'rejected', code: 'usage_capped' };
      if (
        /user-suspended|client-not-enrolled|unsupported-authentication|oauth1-permissions|client-forbidden/i.test(
          body,
        )
      )
        return { kind: 'reconnect_required' };
      return { kind: 'rejected', code: `x_forbidden` };
    }
    if (s >= 400 && s < 500) {
      const title = /"title"\s*:\s*"([^"]+)"/
        .exec(body)?.[1]
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, '_');
      return { kind: 'rejected', code: `x_${title ?? s}` };
    }
    return { kind: 'unknown' };
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private async tokenRequest(
    io: ProviderIO,
    client: ClientConfig,
    params: Record<string, string>,
  ): Promise<ProviderResponse> {
    const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64');
    const { res } = await io.request(
      `${X_API}/oauth2/token`,
      {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: formEncode(params),
      },
      { mutation: true }, // effecting: a code is spent and refresh tokens rotate
    );
    return readResponse(res);
  }

  private async api(
    io: ProviderIO,
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
    mutation = false,
  ): Promise<ProviderResponse> {
    const { res } = await io.request(
      `${X_API}${path}`,
      {
        method,
        headers: { ...bearer(token), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      { mutation },
    );
    return readResponse(res);
  }

  private static retryAfter(headers: IOResponse['headers']): number | undefined {
    for (const name of ['x-rate-limit-reset', 'x-user-limit-24hour-reset']) {
      const reset = num(headers.get(name));
      if (reset !== undefined) return Math.min(15 * 60_000, Math.max(1000, reset * 1000 - Date.now()));
    }
    return undefined;
  }

  private async uploadMedia(
    io: ProviderIO,
    token: string,
    m: PublishMedia,
    boundary: EffectBoundary,
  ): Promise<{ id: string; processing: boolean } | PublishOutcome> {
    const classify = (i: Parameters<ProviderAdapter['classifyError']>[0]): ProviderErrorClass =>
      this.classifyError(i);
    const bytes = await fetchBytes(io, m.url);
    const category = m.mime.startsWith('video/')
      ? 'tweet_video'
      : m.mime === 'image/gif'
        ? 'tweet_gif'
        : 'tweet_image';
    const init = await this.api(
      io,
      'POST',
      '/media/upload/initialize',
      token,
      { media_type: m.mime, total_bytes: bytes.byteLength, media_category: category },
      true,
    );
    if (init.status !== 200 && init.status !== 201)
      return outcomeFromResponse(classify, init, boundary, XAdapter.retryAfter);
    const id = str(get(init.json, 'data', 'id'));
    if (!id)
      return { outcome: 'retryable_error', code: 'upload_init_malformed', message: summarise(init, 200) };
    for (let i = 0, segment = 0; i < bytes.byteLength; i += CHUNK_BYTES, segment += 1) {
      const form = multipart([
        { name: 'segment_index', value: String(segment) },
        {
          name: 'media',
          value: bytes.subarray(i, i + CHUNK_BYTES),
          filename: 'chunk',
          contentType: 'application/octet-stream',
        },
      ]);
      const { res } = await io.request(
        `${X_API}/media/upload/${encodeURIComponent(id)}/append`,
        { method: 'POST', headers: { ...bearer(token), 'content-type': form.contentType }, body: form.body },
        { mutation: true },
      );
      const append = await readResponse(res);
      if (append.status >= 300) return outcomeFromResponse(classify, append, boundary, XAdapter.retryAfter);
    }
    const fin = await this.api(
      io,
      'POST',
      `/media/upload/${encodeURIComponent(id)}/finalize`,
      token,
      {},
      true,
    );
    if (fin.status >= 300) return outcomeFromResponse(classify, fin, boundary, XAdapter.retryAfter);
    const info = get(fin.json, 'data', 'processing_info');
    if (str(get(info, 'state')) === 'failed')
      return {
        outcome: 'rejected',
        code: 'media_processing_failed',
        message: str(get(info, 'error', 'message')) ?? id,
      };
    if (m.altText) {
      const meta = await this.api(
        io,
        'POST',
        '/media/metadata',
        token,
        { id, metadata: { alt_text: { text: m.altText } } },
        true,
      );
      if (meta.status >= 300) return outcomeFromResponse(classify, meta, boundary, XAdapter.retryAfter);
    }
    // A missing processing_info means the media is ready; anything not yet succeeded keeps transcoding.
    return { id, processing: info !== undefined && str(get(info, 'state')) !== 'succeeded' };
  }

  private tweetsCreate(
    io: ProviderIO,
    token: string,
    t: { text: string; mediaIds: readonly string[]; replySettings?: string | undefined; inReplyTo?: string },
  ): Promise<ProviderResponse> {
    return this.api(
      io,
      'POST',
      '/tweets',
      token,
      {
        text: t.text,
        ...(t.mediaIds.length ? { media: { media_ids: t.mediaIds } } : {}),
        ...(t.replySettings && t.replySettings !== 'everyone' ? { reply_settings: t.replySettings } : {}),
        ...(t.inReplyTo ? { reply: { in_reply_to_tweet_id: t.inReplyTo } } : {}),
      },
      true,
    );
  }

  private async createTweet(
    io: ProviderIO,
    token: string,
    t: {
      text: string;
      mediaIds: readonly string[];
      replySettings?: string | undefined;
      inReplyTo?: string;
      username: string | undefined;
    },
    boundary: EffectBoundary,
  ): Promise<PublishOutcome> {
    boundary.cross();
    const res = await this.tweetsCreate(io, token, t);
    if (res.status !== 201 && res.status !== 200)
      return outcomeFromResponse((i) => this.classifyError(i), res, boundary, XAdapter.retryAfter);
    const id = str(get(res.json, 'data', 'id'));
    if (!id) return { outcome: 'unknown', code: 'missing_post_id', message: summarise(res, 200) };
    return { outcome: 'accepted', remotePostId: id, remoteUrl: tweetUrl(t.username, id) };
  }

  /** Recent posts by the user since the attempt; X rewrites links to t.co, so entities.urls restore the original text. */
  private async scanRecent(
    io: ProviderIO,
    token: string,
    userId: string,
    since: Date,
  ): Promise<{ posts: RecentPost[]; covered: boolean; reason?: string }> {
    const posts: RecentPost[] = [];
    const startTime = new Date(Math.max(0, since.getTime() - 5 * 60_000)).toISOString();
    let next: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      const q = new URLSearchParams({
        start_time: startTime,
        max_results: '100',
        'tweet.fields': 'id,text,created_at,entities',
        exclude: 'retweets',
        ...(next ? { pagination_token: next } : {}),
      });
      const res = await this.api(
        io,
        'GET',
        `/users/${encodeURIComponent(userId)}/tweets?${q.toString()}`,
        token,
      );
      if (res.status !== 200) return { posts, covered: false, reason: `scan_http_${res.status}` };
      for (const t of arr(get(res.json, 'data'))) {
        const id = str(get(t, 'id'));
        if (!id) continue;
        const created = str(get(t, 'created_at'));
        posts.push({
          id,
          text: restoreUrls(t),
          createdAt: created ? Date.parse(created) : undefined,
          url: tweetUrl(undefined, id),
        });
      }
      next = str(get(res.json, 'meta', 'next_token'));
      if (!next) return { posts, covered: true };
    }
    return { posts, covered: false, reason: 'scan_pages_exhausted' };
  }

  private async completedPost(
    io: ProviderIO,
    token: string,
    data: PendingData,
  ): Promise<PendingCheck | undefined> {
    const scan = await this.scanRecent(io, token, data.userId, new Date(data.attemptStartedAt));
    const r = reconcileFromScan(scan, {
      attemptStartedAt: new Date(data.attemptStartedAt),
      textFingerprint: data.textFingerprint,
    });
    return r.status === 'found'
      ? {
          status: 'completed',
          remotePostId: r.remotePostId,
          remoteUrl: tweetUrl(data.username, r.remotePostId),
        }
      : undefined;
  }
}

/** Replaces each t.co link in the post text with its expanded URL (entities.urls carries start/end code-point offsets). */
function restoreUrls(tweet: unknown): string | undefined {
  const text = str(get(tweet, 'text'));
  if (text === undefined) return undefined;
  const urls = arr(get(tweet, 'entities', 'urls'))
    .map((u) => ({ url: str(get(u, 'url')) ?? '', expanded: str(get(u, 'expanded_url')) ?? '' }))
    .filter((u) => u.url && u.expanded);
  return urls.reduce((t, u) => t.split(u.url).join(u.expanded), text);
}

export const xAdapter = new XAdapter();
