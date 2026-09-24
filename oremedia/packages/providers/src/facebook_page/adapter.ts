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
import type { CommentRequest, ProviderAdapter, PublishRequest } from '../contract';
import { ProviderTransportError, type ProviderIO } from '../io';
import { plainMeasure, validateVariantAgainstCapability } from '../capability';
import {
  EffectBoundary,
  ProviderAuthError,
  altTextIssues,
  arr,
  checkFailure,
  expiresAtFrom,
  get,
  metricPoint,
  num,
  outcomeFromResponse,
  reconcileFromScan,
  runCheck,
  runPublish,
  str,
  summarise,
  sumValue,
  unixSeconds,
  withIssues,
  type RecentPost,
} from '../shared';
import { facebookPageCapability } from './capability';
import {
  MetaGraphError,
  alternativesFrom,
  classifyMetaError,
  graphGet,
  graphPost,
  listPages,
  metaAuthorizationUrl,
  metaExchangeCode,
  metaExtendToken,
  metaRefreshFailure,
  metaRetryAfterMs,
} from './graph';

const ALT_TEXT_MAX = 1000;

/** PendingState.data for a video post: the post exists, the video is still processing. */
const PendingData = z.object({
  v: z.literal(1),
  kind: z.literal('video'),
  pageId: z.string(),
  videoId: z.string(),
  textFingerprint: z.string(),
  attemptStartedAt: z.string(),
});

const postUrl = (id: string): string => `https://www.facebook.com/${id}`;

/**
 * Facebook Page adapter (spec 14.5, 14.8). Photos are uploaded unpublished then attached to one /feed post (the
 * effect boundary); text posts go straight to /feed; a video post is created by /videos (boundary) and reported
 * `pending` until Meta finishes processing it. No finalize: nothing is left to mutate after publish.
 */
export class FacebookPageAdapter implements ProviderAdapter {
  readonly key = 'facebook_page';
  readonly capability = facebookPageCapability;
  private readonly plain = plainMeasure(facebookPageCapability.text.maxLength);

  async authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    client: ClientConfig;
  }): Promise<{ url: string }> {
    return { url: metaAuthorizationUrl({ ...input, scopes: this.capability.requiredScopes }) };
  }

  async exchangeCode(
    input: { code: string; codeVerifier: string; redirectUri: string; client: ClientConfig },
    io: ProviderIO,
  ): Promise<AccountGrant> {
    const user = await metaExchangeCode(input, io, (code, detail) => {
      throw new ProviderAuthError(this.key, code, detail);
    });
    const pages = await this.pages(io, user.accessToken);
    const [primary, ...rest] = pages;
    if (!primary)
      throw new ProviderAuthError(this.key, 'no_eligible_account', 'no Facebook Page on this account');
    return {
      remoteAccountId: primary.id,
      displayName: primary.name,
      grantedScopes: user.grantedScopes,
      credentials: this.pageCredentials(primary.accessToken, user.accessToken, primary.id, user.expiresAt),
      ...(user.expiresAt ? { tokenExpiresAt: user.expiresAt } : {}),
      alternatives: alternativesFrom(rest, primary.id),
    };
  }

  /** Re-targets a grant at another page using the stored user token (connect flow "choose a page"); not part of the contract. */
  async selectAccount(
    credentials: DecryptedCredentials,
    remoteAccountId: string,
    io: ProviderIO,
    grantedScopes: string[] = [],
  ): Promise<AccountGrant> {
    const userToken = credentials.extra?.['userAccessToken'] ?? credentials.accessToken;
    const pages = await this.pages(io, userToken);
    const chosen = pages.find((p) => p.id === remoteAccountId);
    if (!chosen) throw new ProviderAuthError(this.key, 'account_not_found', remoteAccountId);
    return {
      remoteAccountId: chosen.id,
      displayName: chosen.name,
      grantedScopes,
      credentials: this.pageCredentials(chosen.accessToken, userToken, chosen.id, credentials.expiresAt),
      ...(credentials.expiresAt ? { tokenExpiresAt: credentials.expiresAt } : {}),
      alternatives: alternativesFrom(pages, chosen.id),
    };
  }

  async refresh(
    credentials: DecryptedCredentials,
    client: ClientConfig,
    io: ProviderIO,
  ): Promise<RefreshResult> {
    const userToken = credentials.extra?.['userAccessToken'];
    const pageId = credentials.extra?.['pageId'];
    if (!userToken || !pageId) return { ok: false, reason: 'reconnect_required' };
    try {
      const long = await metaExtendToken(userToken, client, io);
      const newUser = str(get(long.json, 'access_token'));
      if (long.status !== 200 || !newUser) return metaRefreshFailure(long);
      const page = await graphGet(io, `/${pageId}`, newUser, { fields: 'access_token' });
      const pageToken = str(get(page.json, 'access_token'));
      if (page.status !== 200 || !pageToken) return metaRefreshFailure(page);
      const expiresAt = expiresAtFrom(num(get(long.json, 'expires_in')));
      return {
        ok: true,
        credentials: this.pageCredentials(pageToken, newUser, pageId, expiresAt),
        ...(expiresAt ? { tokenExpiresAt: expiresAt } : {}),
      };
    } catch (err) {
      if (err instanceof ProviderTransportError) return { ok: false, reason: 'transient' };
      throw err;
    }
  }

  validateVariant(variant: ChannelVariantInput): ValidationResult {
    const base = validateVariantAgainstCapability(this.capability, variant, this.plain);
    const extra: ValidationResult['issues'] = altTextIssues(variant, ALT_TEXT_MAX);
    const videos = variant.media.filter((m) => m.mime.startsWith('video/')).length;
    if (videos > 1) extra.push({ path: 'media', issue: 'multiple_videos_not_supported' });
    if (videos > 0 && variant.media.length > videos)
      extra.push({ path: 'media', issue: 'mixed_media_not_supported' });
    return withIssues(base, extra);
  }

  measureText(text: string): { length: number; limit: number } {
    return this.plain(text);
  }

  async publish(req: PublishRequest, creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome> {
    const boundary = new EffectBoundary();
    const classify = (i: Parameters<ProviderAdapter['classifyError']>[0]): ProviderErrorClass =>
      this.classifyError(i);
    return runPublish(boundary, async () => {
      const pageId = req.remoteAccountId;
      const video = req.media.find((m) => m.mime.startsWith('video/'));
      if (video) {
        boundary.cross();
        const res = await graphPost(io, `/${pageId}/videos`, creds.accessToken, {
          file_url: video.url,
          description: req.text,
          published: true,
        });
        if (res.status !== 200) return outcomeFromResponse(classify, res, boundary, metaRetryAfterMs);
        const videoId = str(get(res.json, 'id'));
        if (!videoId) return { outcome: 'unknown', code: 'missing_post_id', message: summarise(res, 200) };
        const data: z.infer<typeof PendingData> = {
          v: 1,
          kind: 'video',
          pageId,
          videoId,
          textFingerprint: req.textFingerprint,
          attemptStartedAt: new Date().toISOString(),
        };
        return { outcome: 'pending', pending: { remoteJobId: videoId, data }, remoteJobId: videoId };
      }
      const attached: Array<{ media_fbid: string }> = [];
      for (const m of req.media) {
        const res = await graphPost(io, `/${pageId}/photos`, creds.accessToken, {
          url: m.url,
          published: false,
          ...(m.altText ? { alt_text_custom: m.altText } : {}),
        });
        if (res.status !== 200) return outcomeFromResponse(classify, res, boundary, metaRetryAfterMs);
        const id = str(get(res.json, 'id'));
        if (!id)
          return { outcome: 'retryable_error', code: 'photo_upload_malformed', message: summarise(res, 200) };
        attached.push({ media_fbid: id });
      }
      const link = str(req.settings['link']);
      boundary.cross();
      const res = await graphPost(io, `/${pageId}/feed`, creds.accessToken, {
        message: req.text,
        published: true,
        ...(attached.length ? { attached_media: attached } : {}),
        ...(link ? { link } : {}),
      });
      if (res.status !== 200) return outcomeFromResponse(classify, res, boundary, metaRetryAfterMs);
      const id = str(get(res.json, 'id'));
      if (!id) return { outcome: 'unknown', code: 'missing_post_id', message: summarise(res, 200) };
      return {
        outcome: 'accepted',
        remotePostId: id,
        remoteUrl: await this.permalink(io, creds.accessToken, id),
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
    const { videoId } = parsed.data;
    return runCheck(async () => {
      const res = await graphGet(io, `/${videoId}`, creds.accessToken, { fields: 'id,status,permalink_url' });
      if (res.status !== 200) return checkFailure((i) => this.classifyError(i), res);
      const state = str(get(res.json, 'status', 'video_status')) ?? 'processing';
      if (state === 'error')
        return { status: 'failed', code: 'video_processing_failed', message: summarise(res, 300) };
      if (state !== 'ready' && state !== 'upload_complete')
        return { status: 'processing', retryAfterMs: 30_000 };
      const permalink = str(get(res.json, 'permalink_url'));
      return {
        status: 'completed',
        remotePostId: videoId,
        remoteUrl: permalink ? absolute(permalink) : postUrl(videoId),
      };
    });
  }

  async comment(req: CommentRequest, creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome> {
    const boundary = new EffectBoundary();
    return runPublish(boundary, async () => {
      boundary.cross();
      const res = await graphPost(io, `/${req.remotePostId}/comments`, creds.accessToken, {
        message: req.text,
      });
      if (res.status !== 200)
        return outcomeFromResponse((i) => this.classifyError(i), res, boundary, metaRetryAfterMs);
      const id = str(get(res.json, 'id'));
      if (!id) return { outcome: 'unknown', code: 'missing_comment_id', message: summarise(res, 200) };
      return { outcome: 'accepted', remotePostId: id, remoteUrl: postUrl(id) };
    });
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
    const res = await graphGet(io, `/${req.remotePostId}/insights`, creds.accessToken, {
      metric: names.join(','),
    });
    if (res.status !== 200) return names.map((n) => metricPoint(n, undefined, req.window));
    const byName = new Map(
      arr(get(res.json, 'data')).map((d) => [
        str(get(d, 'name')) ?? '',
        sumValue(get(arr(get(d, 'values'))[0], 'value')),
      ]),
    );
    return names.map((n) => metricPoint(n, byName.get(n), req.window, { unit: 'lifetime_count' }));
  }

  async fetchAccountMetrics(
    req: { remoteAccountId: string; window: MetricWindow },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<RawMetricPoint[]> {
    const names = this.capability.analytics.account;
    const res = await graphGet(io, `/${req.remoteAccountId}/insights`, creds.accessToken, {
      metric: names.join(','),
      period: 'day',
      since: String(unixSeconds(new Date(req.window.start))),
      until: String(unixSeconds(new Date(req.window.end))),
    });
    if (res.status !== 200) return names.map((n) => metricPoint(n, undefined, req.window));
    const data = arr(get(res.json, 'data'));
    return names.map((n) => {
      const d = data.find((x) => get(x, 'name') === n);
      if (!d) return metricPoint(n, undefined, req.window);
      const series = arr(get(d, 'values'))
        .map((v) => ({ at: str(get(v, 'end_time')) ?? '', value: sumValue(get(v, 'value')) }))
        .filter((p): p is { at: string; value: number } => p.at !== '' && p.value !== undefined);
      return metricPoint(n, series.length ? series.reduce((s, p) => s + p.value, 0) : undefined, req.window, {
        series,
      });
    });
  }

  async fetchComments(
    req: { remotePostId: string; since?: Date; cursor?: string },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<CommentPage> {
    const res = await graphGet(io, `/${req.remotePostId}/comments`, creds.accessToken, {
      fields: 'id,message,from{id,name},created_time,parent{id}',
      filter: 'stream',
      limit: '50',
      ...(req.cursor ? { after: req.cursor } : {}),
      ...(req.since ? { since: String(unixSeconds(req.since)) } : {}),
    });
    if (res.status !== 200) throw new MetaGraphError('comments', res);
    const items = arr(get(res.json, 'data'))
      .map((c) => ({
        remoteCommentId: str(get(c, 'id')) ?? '',
        authorHandle: str(get(c, 'from', 'name')) ?? str(get(c, 'from', 'id')) ?? '',
        text: str(get(c, 'message')) ?? '',
        createdAt: new Date(str(get(c, 'created_time')) ?? 0).toISOString(),
        ...(str(get(c, 'parent', 'id')) ? { parentRemoteId: str(get(c, 'parent', 'id')) } : {}),
      }))
      .filter((c) => c.remoteCommentId);
    const after = str(get(res.json, 'paging', 'cursors', 'after'));
    return { items, ...(after && get(res.json, 'paging', 'next') ? { nextCursor: after } : {}) };
  }

  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass {
    return classifyMetaError(input);
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private pageCredentials(
    pageToken: string,
    userToken: string,
    pageId: string,
    expiresAt: string | undefined,
  ): DecryptedCredentials {
    return {
      accessToken: pageToken,
      ...(expiresAt ? { expiresAt } : {}),
      extra: { pageId, userAccessToken: userToken },
    };
  }

  private async pages(
    io: ProviderIO,
    userToken: string,
  ): Promise<Array<{ id: string; name: string; accessToken: string }>> {
    try {
      return await listPages(io, userToken);
    } catch (err) {
      if (err instanceof MetaGraphError)
        throw new ProviderAuthError(this.key, 'identity_failed', err.message);
      throw err;
    }
  }

  /** Cosmetic: the post is live, a failed permalink read never fails the publish. */
  private async permalink(io: ProviderIO, token: string, id: string): Promise<string> {
    try {
      const res = await graphGet(io, `/${id}`, token, { fields: 'permalink_url' });
      const p = str(get(res.json, 'permalink_url'));
      return res.status === 200 && p ? absolute(p) : postUrl(id);
    } catch (err) {
      if (err instanceof ProviderTransportError) return postUrl(id);
      throw err;
    }
  }

  private async scanRecent(
    io: ProviderIO,
    token: string,
    pageId: string,
    since: Date,
  ): Promise<{ posts: RecentPost[]; covered: boolean; reason?: string }> {
    const posts: RecentPost[] = [];
    let next: string | undefined = `/${pageId}/posts`;
    let params: Record<string, string> | undefined = {
      fields: 'id,message,created_time,permalink_url',
      since: String(unixSeconds(new Date(since.getTime() - 5 * 60_000))),
      limit: '50',
    };
    for (let page = 0; page < 3 && next; page += 1) {
      const res = await graphGet(io, next, token, params);
      if (res.status !== 200) return { posts, covered: false, reason: `scan_http_${res.status}` };
      for (const el of arr(get(res.json, 'data'))) {
        const id = str(get(el, 'id'));
        if (!id) continue;
        const created = str(get(el, 'created_time'));
        const permalink = str(get(el, 'permalink_url'));
        posts.push({
          id,
          text: str(get(el, 'message')),
          createdAt: created ? Date.parse(created) : undefined,
          url: permalink ? absolute(permalink) : postUrl(id),
        });
      }
      next = str(get(res.json, 'paging', 'next'));
      params = undefined;
    }
    // `since` bounds the scan by construction: exhausting the pages covers the window.
    return next ? { posts, covered: false, reason: 'scan_pages_exhausted' } : { posts, covered: true };
  }
}

const absolute = (permalink: string): string =>
  permalink.startsWith('http') ? permalink : `https://www.facebook.com${permalink}`;

export const facebookPageAdapter = new FacebookPageAdapter();
