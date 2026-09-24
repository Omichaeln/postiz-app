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
  finalizeFailure,
  get,
  matchRecent,
  metricPoint,
  num,
  outcomeFromResponse,
  reconcileFromScan,
  runCheck,
  runFinalize,
  runPublish,
  str,
  summarise,
  sumValue,
  unixSeconds,
  withIssues,
  type ProviderResponse,
  type RecentPost,
} from '../shared';
import { instagramBusinessCapability } from './capability';
import {
  MetaGraphError,
  alternativesFrom,
  classifyMetaError,
  graphGet,
  graphPost,
  listPages,
  metaAuthorizationUrl,
  metaError,
  metaExchangeCode,
  metaExtendToken,
  metaRefreshFailure,
  metaRetryAfterMs,
} from '../facebook_page/graph';

const ALT_TEXT_MAX = 1000;
/** Meta subcode when media_publish is called before the container reached FINISHED. */
const MEDIA_NOT_READY_SUBCODE = 2207027;

/** PendingState.data: the container to publish, plus what checkStatus needs to recognise a finished publish. */
const PendingData = z.object({
  v: z.literal(1),
  igUserId: z.string(),
  containerId: z.string(),
  kind: z.enum(['image', 'reel', 'carousel']),
  caption: z.string(),
  textFingerprint: z.string(),
  attemptStartedAt: z.string(),
  username: z.string().optional(),
});
type PendingData = z.infer<typeof PendingData>;

const profileUrl = (username: string | undefined, id: string): string =>
  username ? `https://www.instagram.com/${username}/` : `https://www.instagram.com/p/${id}`;

/**
 * Instagram Business adapter (spec 14.5, 14.8). publish creates media containers (invisible until published),
 * returns `pending`; checkStatus polls the container; finalize calls media_publish (the effect boundary). Edge
 * cases learned from the Postiz reference as patterns: container status polling with FINISHED/IN_PROGRESS/
 * ERROR/EXPIRED/PUBLISHED, and finalize checking for an already PUBLISHED container before publishing again.
 */
export class InstagramBusinessAdapter implements ProviderAdapter {
  readonly key = 'instagram_business';
  readonly capability = instagramBusinessCapability;
  private readonly plain = plainMeasure(instagramBusinessCapability.text.maxLength);

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
    const accounts = await this.igAccounts(io, user.accessToken);
    const [primary, ...rest] = accounts;
    if (!primary)
      throw new ProviderAuthError(
        this.key,
        'no_eligible_account',
        'no Facebook Page with a connected Instagram professional account',
      );
    return {
      remoteAccountId: primary.id,
      displayName: primary.name,
      grantedScopes: user.grantedScopes,
      credentials: this.igCredentials(user.accessToken, primary, user.expiresAt),
      ...(user.expiresAt ? { tokenExpiresAt: user.expiresAt } : {}),
      alternatives: alternativesFrom(rest, primary.id),
    };
  }

  /** Re-targets a grant at another connected Instagram account; not part of the contract. */
  async selectAccount(
    credentials: DecryptedCredentials,
    remoteAccountId: string,
    io: ProviderIO,
    grantedScopes: string[] = [],
  ): Promise<AccountGrant> {
    const accounts = await this.igAccounts(io, credentials.accessToken);
    const chosen = accounts.find((a) => a.id === remoteAccountId);
    if (!chosen) throw new ProviderAuthError(this.key, 'account_not_found', remoteAccountId);
    return {
      remoteAccountId: chosen.id,
      displayName: chosen.name,
      grantedScopes,
      credentials: this.igCredentials(credentials.accessToken, chosen, credentials.expiresAt),
      ...(credentials.expiresAt ? { tokenExpiresAt: credentials.expiresAt } : {}),
      alternatives: alternativesFrom(accounts, chosen.id),
    };
  }

  async refresh(
    credentials: DecryptedCredentials,
    client: ClientConfig,
    io: ProviderIO,
  ): Promise<RefreshResult> {
    try {
      const long = await metaExtendToken(credentials.accessToken, client, io);
      const accessToken = str(get(long.json, 'access_token'));
      if (long.status !== 200 || !accessToken) return metaRefreshFailure(long);
      const expiresAt = expiresAtFrom(num(get(long.json, 'expires_in')));
      return {
        ok: true,
        credentials: { ...credentials, accessToken, ...(expiresAt ? { expiresAt } : {}) },
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
    if (variant.media.length === 0) extra.push({ path: 'media', issue: 'media_required' });
    if ((variant.text.match(/(^|\s)#\w+/g) ?? []).length > 30)
      extra.push({ path: 'text', issue: 'too_many_hashtags:>30' });
    if ((variant.text.match(/(^|\s)@\w+/g) ?? []).length > 20)
      extra.push({ path: 'text', issue: 'too_many_mentions:>20' });
    return withIssues(base, extra);
  }

  measureText(text: string): { length: number; limit: number } {
    return this.plain(text);
  }

  async publish(req: PublishRequest, creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome> {
    const boundary = new EffectBoundary(); // never crossed here: containers are invisible until media_publish
    const classify = (i: Parameters<ProviderAdapter['classifyError']>[0]): ProviderErrorClass =>
      this.classifyError(i);
    return runPublish(boundary, async () => {
      const igUserId = req.remoteAccountId;
      if (req.media.length === 0)
        return {
          outcome: 'rejected',
          code: 'media_required',
          message: 'Instagram posts need at least one media item',
        };
      const create = async (body: Record<string, unknown>): Promise<string | PublishOutcome> => {
        const res = await graphPost(io, `/${igUserId}/media`, creds.accessToken, body);
        if (res.status !== 200) return outcomeFromResponse(classify, res, boundary, metaRetryAfterMs);
        const id = str(get(res.json, 'id'));
        return (
          id ?? { outcome: 'retryable_error', code: 'container_malformed', message: summarise(res, 200) }
        );
      };
      const mediaBody = (
        m: PublishRequest['media'][number],
        carouselItem: boolean,
      ): Record<string, unknown> =>
        m.mime.startsWith('video/')
          ? {
              video_url: m.url,
              media_type: carouselItem ? 'VIDEO' : 'REELS',
              ...(carouselItem ? { is_carousel_item: true } : { share_to_feed: true }),
            }
          : {
              image_url: m.url,
              ...(m.altText ? { alt_text: m.altText } : {}),
              ...(carouselItem ? { is_carousel_item: true } : {}),
            };
      let containerId: string;
      let kind: PendingData['kind'];
      const [single] = req.media;
      if (req.media.length === 1 && single) {
        const id = await create({ ...mediaBody(single, false), caption: req.text });
        if (typeof id !== 'string') return id;
        containerId = id;
        kind = single.mime.startsWith('video/') ? 'reel' : 'image';
      } else {
        const children: string[] = [];
        for (const m of req.media) {
          const id = await create(mediaBody(m, true));
          if (typeof id !== 'string') return id;
          children.push(id);
        }
        const id = await create({ media_type: 'CAROUSEL', children: children.join(','), caption: req.text });
        if (typeof id !== 'string') return id;
        containerId = id;
        kind = 'carousel';
      }
      const data: PendingData = {
        v: 1,
        igUserId,
        containerId,
        kind,
        caption: req.text,
        textFingerprint: req.textFingerprint,
        attemptStartedAt: new Date().toISOString(),
        ...(creds.extra?.['igUsername'] ? { username: creds.extra['igUsername'] } : {}),
      };
      return { outcome: 'pending', pending: { containerId, data }, remoteJobId: containerId };
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
      const status = await this.containerStatus(io, creds.accessToken, data.containerId);
      if ('check' in status) return status.check;
      switch (status.code) {
        case 'FINISHED':
          return { status: 'ready' };
        case 'PUBLISHED':
          // Spec 20.3: a finalise went through; report completed, never ready again.
          return this.completedFromContainer(io, creds.accessToken, data);
        case 'IN_PROGRESS':
          return { status: 'processing', retryAfterMs: 10_000 };
        default:
          return {
            status: 'failed',
            code: `ig_container_${status.code.toLowerCase()}`,
            message: status.message ?? status.code,
          };
      }
    });
  }

  async finalize(pending: PendingState, creds: DecryptedCredentials, io: ProviderIO): Promise<PendingCheck> {
    const parsed = PendingData.safeParse(pending.data);
    if (!parsed.success)
      return { status: 'failed', code: 'pending_state_invalid', message: parsed.error.message };
    const data = parsed.data;
    return runFinalize(async () => {
      // "Finalize already completed" check: never call media_publish on a container that is already PUBLISHED.
      const status = await this.containerStatus(io, creds.accessToken, data.containerId);
      if ('check' in status) return status.check;
      if (status.code === 'PUBLISHED') return this.completedFromContainer(io, creds.accessToken, data);
      if (status.code === 'IN_PROGRESS') return { status: 'processing', retryAfterMs: 10_000 };
      if (status.code !== 'FINISHED')
        return {
          status: 'failed',
          code: `ig_container_${status.code.toLowerCase()}`,
          message: status.message ?? status.code,
        };
      const res = await graphPost(io, `/${data.igUserId}/media_publish`, creds.accessToken, {
        creation_id: data.containerId,
      });
      if (res.status === 200) {
        const mediaId = str(get(res.json, 'id'));
        if (!mediaId) return this.completedFromContainer(io, creds.accessToken, data);
        return {
          status: 'completed',
          remotePostId: mediaId,
          remoteUrl: await this.permalink(io, creds.accessToken, mediaId, data.username),
        };
      }
      if (metaError(res.body).subcode === MEDIA_NOT_READY_SUBCODE)
        return { status: 'processing', retryAfterMs: 10_000 };
      return finalizeFailure((i) => this.classifyError(i), res);
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
      return {
        outcome: 'accepted',
        remotePostId: id,
        remoteUrl: await this.permalink(io, creds.accessToken, req.remotePostId, creds.extra?.['igUsername']),
      };
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
        sumValue(get(d, 'total_value', 'value')) ?? sumValue(get(arr(get(d, 'values'))[0], 'value')),
      ]),
    );
    return names.map((n) => metricPoint(n, byName.get(n), req.window, { unit: 'lifetime_count' }));
  }

  async fetchAccountMetrics(
    req: { remoteAccountId: string; window: MetricWindow },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<RawMetricPoint[]> {
    const since = String(unixSeconds(new Date(req.window.start)));
    const until = String(unixSeconds(new Date(req.window.end)));
    const timeSeries = ['follower_count', 'reach'];
    const totals = this.capability.analytics.account.filter((n) => !timeSeries.includes(n));
    const [series, total] = await Promise.all([
      graphGet(io, `/${req.remoteAccountId}/insights`, creds.accessToken, {
        metric: timeSeries.join(','),
        period: 'day',
        since,
        until,
      }),
      graphGet(io, `/${req.remoteAccountId}/insights`, creds.accessToken, {
        metric: totals.join(','),
        period: 'day',
        metric_type: 'total_value',
        since,
        until,
      }),
    ]);
    return this.capability.analytics.account.map((n) => {
      const res = timeSeries.includes(n) ? series : total;
      if (res.status !== 200) return metricPoint(n, undefined, req.window);
      const d = arr(get(res.json, 'data')).find((x) => get(x, 'name') === n);
      if (!d) return metricPoint(n, undefined, req.window);
      const totalValue = sumValue(get(d, 'total_value', 'value'));
      if (totalValue !== undefined) return metricPoint(n, totalValue, req.window);
      const points = arr(get(d, 'values'))
        .map((v) => ({ at: str(get(v, 'end_time')) ?? '', value: sumValue(get(v, 'value')) }))
        .filter((p): p is { at: string; value: number } => p.at !== '' && p.value !== undefined);
      return metricPoint(n, points.length ? points.reduce((s, p) => s + p.value, 0) : undefined, req.window, {
        series: points,
      });
    });
  }

  async fetchComments(
    req: { remotePostId: string; since?: Date; cursor?: string },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<CommentPage> {
    const res = await graphGet(io, `/${req.remotePostId}/comments`, creds.accessToken, {
      fields: 'id,text,username,timestamp,replies{id,text,username,timestamp}',
      limit: '50',
      ...(req.cursor ? { after: req.cursor } : {}),
    });
    if (res.status !== 200) throw new MetaGraphError('comments', res);
    const toItem = (c: unknown, parent?: string): CommentPage['items'][number] => ({
      remoteCommentId: str(get(c, 'id')) ?? '',
      authorHandle: str(get(c, 'username')) ?? '',
      text: str(get(c, 'text')) ?? '',
      createdAt: new Date(str(get(c, 'timestamp')) ?? 0).toISOString(),
      ...(parent ? { parentRemoteId: parent } : {}),
    });
    const items = arr(get(res.json, 'data'))
      .flatMap((c) => [toItem(c), ...arr(get(c, 'replies', 'data')).map((r) => toItem(r, str(get(c, 'id'))))])
      .filter((c) => c.remoteCommentId && (!req.since || Date.parse(c.createdAt) >= req.since.getTime()));
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

  private igCredentials(
    userToken: string,
    account: { id: string; pageId: string; username?: string },
    expiresAt: string | undefined,
  ): DecryptedCredentials {
    return {
      accessToken: userToken,
      ...(expiresAt ? { expiresAt } : {}),
      extra: {
        igUserId: account.id,
        pageId: account.pageId,
        ...(account.username ? { igUsername: account.username } : {}),
      },
    };
  }

  private async igAccounts(
    io: ProviderIO,
    userToken: string,
  ): Promise<Array<{ id: string; name: string; pageId: string; username?: string }>> {
    try {
      return (await listPages(io, userToken))
        .filter((p): p is typeof p & { igAccountId: string } => typeof p.igAccountId === 'string')
        .map((p) => ({
          id: p.igAccountId,
          name: p.igUsername ? `@${p.igUsername}` : p.name,
          pageId: p.id,
          ...(p.igUsername ? { username: p.igUsername } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch (err) {
      if (err instanceof MetaGraphError)
        throw new ProviderAuthError(this.key, 'identity_failed', err.message);
      throw err;
    }
  }

  private async containerStatus(
    io: ProviderIO,
    token: string,
    containerId: string,
  ): Promise<{ code: string; message?: string } | { check: PendingCheck }> {
    const res = await graphGet(io, `/${containerId}`, token, { fields: 'status_code,status' });
    if (res.status !== 200) return { check: checkFailure((i) => this.classifyError(i), res) };
    const code = str(get(res.json, 'status_code'));
    if (!code)
      return {
        check: { status: 'failed', code: 'ig_container_status_missing', message: summarise(res, 200) },
      };
    return { code, ...(str(get(res.json, 'status')) ? { message: str(get(res.json, 'status')) } : {}) };
  }

  /** The container is PUBLISHED but its media id is not on the container: find the media by caption fingerprint. */
  private async completedFromContainer(
    io: ProviderIO,
    token: string,
    data: PendingData,
  ): Promise<PendingCheck> {
    const scan = await this.scanRecent(io, token, data.igUserId, new Date(data.attemptStartedAt));
    const match = matchRecent(scan.posts, {
      attemptStartedAt: new Date(data.attemptStartedAt),
      textFingerprint: data.textFingerprint,
    });
    if (match) return { status: 'completed', remotePostId: match.id, remoteUrl: match.url };
    return {
      status: 'completed',
      remotePostId: data.containerId,
      remoteUrl: profileUrl(data.username, data.containerId),
    };
  }

  private async permalink(
    io: ProviderIO,
    token: string,
    mediaId: string,
    username: string | undefined,
  ): Promise<string> {
    try {
      const res: ProviderResponse = await graphGet(io, `/${mediaId}`, token, { fields: 'permalink' });
      return (res.status === 200 && str(get(res.json, 'permalink'))) || profileUrl(username, mediaId);
    } catch (err) {
      if (err instanceof ProviderTransportError) return profileUrl(username, mediaId);
      throw err;
    }
  }

  private async scanRecent(
    io: ProviderIO,
    token: string,
    igUserId: string,
    since: Date,
  ): Promise<{ posts: RecentPost[]; covered: boolean; reason?: string }> {
    const posts: RecentPost[] = [];
    let next: string | undefined = `/${igUserId}/media`;
    let params: Record<string, string> | undefined = {
      fields: 'id,caption,timestamp,permalink',
      since: String(unixSeconds(new Date(since.getTime() - 5 * 60_000))),
      limit: '50',
    };
    for (let page = 0; page < 3 && next; page += 1) {
      const res = await graphGet(io, next, token, params);
      if (res.status !== 200) return { posts, covered: false, reason: `scan_http_${res.status}` };
      for (const el of arr(get(res.json, 'data'))) {
        const id = str(get(el, 'id'));
        if (!id) continue;
        const ts = str(get(el, 'timestamp'));
        posts.push({
          id,
          text: str(get(el, 'caption')),
          createdAt: ts ? Date.parse(ts) : undefined,
          url: str(get(el, 'permalink')) ?? `https://www.instagram.com/p/${id}`,
        });
      }
      next = str(get(res.json, 'paging', 'next'));
      params = undefined;
    }
    return next ? { posts, covered: false, reason: 'scan_pages_exhausted' } : { posts, covered: true };
  }
}

export const instagramBusinessAdapter = new InstagramBusinessAdapter();
