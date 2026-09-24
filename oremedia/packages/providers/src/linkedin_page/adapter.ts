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
import { classifyByStatus, retryAfterMs } from '../base';
import { plainMeasure, validateVariantAgainstCapability } from '../capability';
import {
  AmbiguousMutationError,
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
  num,
  outcomeFromResponse,
  readResponse,
  reconcileFromScan,
  runCheck,
  runFinalize,
  runPublish,
  str,
  summarise,
  textFingerprint,
  withIssues,
  type ProviderResponse,
  type RecentPost,
} from '../shared';
import { linkedInPageCapability } from './capability';

export const LINKEDIN_API = 'https://api.linkedin.com';
export const LINKEDIN_OAUTH = 'https://www.linkedin.com/oauth/v2';
/** Versioned API month (YYYYMM). LinkedIn sunsets a version about a year after release: re-derived at certification. */
export const LINKEDIN_VERSION = '202601';
const SCAN_PAGE = 20;
const SCAN_PAGES = 3;
const ALT_TEXT_MAX = 4086;

const restHeaders = (token: string): Record<string, string> => ({
  ...bearer(token),
  'linkedin-version': LINKEDIN_VERSION,
  'x-restli-protocol-version': '2.0.0',
  'content-type': 'application/json',
});

/** Travels through PendingState.data between publish, checkStatus and finalize (validated on read). */
const PendingData = z.object({
  v: z.literal(1),
  remoteAccountId: z.string(),
  authorUrn: z.string(),
  commentary: z.string(),
  media: z.array(
    z.object({ urn: z.string(), kind: z.enum(['image', 'video']), altText: z.string().optional() }),
  ),
  textFingerprint: z.string(),
  attemptStartedAt: z.string(),
});
type PendingData = z.infer<typeof PendingData>;
type UploadedMedia = PendingData['media'][number];

const postUrl = (urn: string): string => `https://www.linkedin.com/feed/update/${urn}`;
const orgUrn = (id: string): string => `urn:li:organization:${id}`;
const orgIdFrom = (urn: string): string => urn.split(':').pop() ?? urn;

/**
 * LinkedIn Page adapter (spec 14.5, 14.8). Flow: register upload → upload bytes → (pending while LinkedIn processes
 * the media) → create the post with /rest/posts. Text-only posts are created directly. Reconciliation and the
 * spec 20.3 invariant use the Posts API "find by author" scan matched by commentary fingerprint.
 */
export class LinkedInPageAdapter implements ProviderAdapter {
  readonly key = 'linkedin_page';
  readonly capability = linkedInPageCapability;
  private readonly plain = plainMeasure(linkedInPageCapability.text.maxLength);

  async authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    client: ClientConfig;
  }): Promise<{ url: string }> {
    // LinkedIn's authorization-code flow has no PKCE parameter; `state` is echoed back and verified by the caller.
    const u = new URL(`${LINKEDIN_OAUTH}/authorization`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', input.client.clientId);
    u.searchParams.set('redirect_uri', input.redirectUri);
    u.searchParams.set('state', input.state);
    u.searchParams.set('scope', this.capability.requiredScopes.join(' '));
    return { url: u.toString() };
  }

  async exchangeCode(
    input: { code: string; codeVerifier: string; redirectUri: string; client: ClientConfig },
    io: ProviderIO,
  ): Promise<AccountGrant> {
    const token = await this.tokenRequest(io, {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.client.clientId,
      client_secret: input.client.clientSecret,
    });
    const accessToken = str(get(token.json, 'access_token'));
    if (token.status !== 200 || !accessToken)
      throw new ProviderAuthError(this.key, 'exchange_failed', summarise(token));
    const grantedScopes = (str(get(token.json, 'scope')) ?? '').split(/[,\s]+/).filter(Boolean);
    const refreshToken = str(get(token.json, 'refresh_token'));
    const tokenExpiresAt = expiresAtFrom(num(get(token.json, 'expires_in')));

    const me = await this.rest(io, 'GET', '/v2/userinfo', accessToken);
    const memberSub = str(get(me.json, 'sub'));
    if (me.status !== 200 || !memberSub)
      throw new ProviderAuthError(this.key, 'identity_failed', summarise(me));

    const orgs = await this.administeredOrganisations(io, accessToken);
    const [primary, ...rest] = orgs;
    if (!primary)
      throw new ProviderAuthError(
        this.key,
        'no_eligible_account',
        'no organisation with ADMINISTRATOR or CONTENT_ADMINISTRATOR role',
      );
    return {
      remoteAccountId: primary.id,
      displayName: primary.name,
      grantedScopes,
      credentials: {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(tokenExpiresAt ? { expiresAt: tokenExpiresAt } : {}),
        extra: { memberSub, organizationUrn: orgUrn(primary.id) },
      },
      ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
      alternatives: rest.map((o) => ({ remoteAccountId: o.id, displayName: o.name })),
    };
  }

  /** Re-targets a grant at another administered organisation (connect flow "choose a page"); not part of the contract. */
  async selectAccount(
    credentials: DecryptedCredentials,
    remoteAccountId: string,
    io: ProviderIO,
    grantedScopes: string[] = [],
  ): Promise<AccountGrant> {
    const orgs = await this.administeredOrganisations(io, credentials.accessToken);
    const chosen = orgs.find((o) => o.id === remoteAccountId);
    if (!chosen) throw new ProviderAuthError(this.key, 'account_not_found', remoteAccountId);
    return {
      remoteAccountId: chosen.id,
      displayName: chosen.name,
      grantedScopes,
      credentials: {
        ...credentials,
        extra: { ...(credentials.extra ?? {}), organizationUrn: orgUrn(chosen.id) },
      },
      ...(credentials.expiresAt ? { tokenExpiresAt: credentials.expiresAt } : {}),
      alternatives: orgs
        .filter((o) => o.id !== chosen.id)
        .map((o) => ({ remoteAccountId: o.id, displayName: o.name })),
    };
  }

  async refresh(
    credentials: DecryptedCredentials,
    client: ClientConfig,
    io: ProviderIO,
  ): Promise<RefreshResult> {
    // Programmatic refresh tokens are issued only to approved LinkedIn partner apps; without one, reconnect.
    if (!credentials.refreshToken) return { ok: false, reason: 'reconnect_required' };
    let res: ProviderResponse;
    try {
      res = await this.tokenRequest(io, {
        grant_type: 'refresh_token',
        refresh_token: credentials.refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      });
    } catch (err) {
      if (err instanceof ProviderTransportError) return { ok: false, reason: 'transient' };
      throw err;
    }
    const accessToken = str(get(res.json, 'access_token'));
    if (res.status === 200 && accessToken) {
      const expiresAt = expiresAtFrom(num(get(res.json, 'expires_in')));
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
    return runPublish(boundary, async () => {
      const authorUrn = orgUrn(req.remoteAccountId);
      const media: UploadedMedia[] = [];
      for (const m of req.media) {
        const uploaded = await this.uploadMedia(io, creds.accessToken, authorUrn, m, boundary);
        if ('outcome' in uploaded) return uploaded;
        media.push(uploaded);
      }
      if (media.length === 0)
        return this.createPost(io, creds.accessToken, authorUrn, req.text, [], boundary);
      const data: PendingData = {
        v: 1,
        remoteAccountId: req.remoteAccountId,
        authorUrn,
        commentary: req.text,
        media,
        textFingerprint: req.textFingerprint,
        attemptStartedAt: new Date().toISOString(),
      };
      return {
        outcome: 'pending',
        pending: { remoteJobId: media[0]?.urn, data },
        remoteJobId: media[0]?.urn,
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
      // Spec 20.3: once the post exists, report completed, never ready again (a retried finalise cannot duplicate).
      const done = await this.completedPost(io, creds.accessToken, data);
      if (done) return done;
      for (const m of data.media) {
        const status = await this.rest(
          io,
          'GET',
          `/rest/${m.kind}s/${encodeURIComponent(m.urn)}`,
          creds.accessToken,
        );
        if (status.status !== 200) return checkFailure((i) => this.classifyError(i), status);
        const s = str(get(status.json, 'status'));
        if (s === 'PROCESSING_FAILED')
          return {
            status: 'failed',
            code: 'media_processing_failed',
            message: str(get(status.json, 'processingFailureReason')) ?? m.urn,
          };
        if (s !== 'AVAILABLE') return { status: 'processing', retryAfterMs: 15_000 };
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
      const res = await this.postsCreate(io, creds.accessToken, data.authorUrn, data.commentary, data.media);
      if (res.status === 201 || res.status === 200) {
        const id = res.headers.get('x-restli-id');
        if (!id)
          throw new AmbiguousMutationError(
            'LinkedIn created the post without returning x-restli-id',
            res.status,
          );
        return { status: 'completed', remotePostId: id, remoteUrl: postUrl(id) };
      }
      // A duplicate rejection means an earlier finalise went through: find it rather than fail.
      if (res.status === 422 && /duplicate/i.test(res.body)) {
        const done = await this.completedPost(io, creds.accessToken, data);
        if (done) return done;
      }
      return finalizeFailure((i) => this.classifyError(i), res);
    });
  }

  async comment(req: CommentRequest, creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome> {
    const boundary = new EffectBoundary();
    return runPublish(boundary, async () => {
      const actor = creds.extra?.['organizationUrn'];
      if (!actor)
        return {
          outcome: 'rejected',
          code: 'missing_organization',
          message: 'credentials carry no organizationUrn',
        };
      boundary.cross();
      const res = await this.rest(
        io,
        'POST',
        `/rest/socialActions/${encodeURIComponent(req.remotePostId)}/comments`,
        creds.accessToken,
        {
          actor,
          object: req.remotePostId,
          message: { text: req.text },
        },
        true,
      );
      if (res.status !== 201 && res.status !== 200)
        return outcomeFromResponse((i) => this.classifyError(i), res, boundary);
      const id = res.headers.get('x-restli-id') ?? str(get(res.json, '$URN')) ?? str(get(res.json, 'id'));
      if (!id)
        return { outcome: 'unknown', code: 'missing_comment_id', message: 'comment created without an id' };
      return { outcome: 'accepted', remotePostId: id, remoteUrl: postUrl(req.remotePostId) };
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
      const scan = await this.scanRecent(io, creds.accessToken, req.remoteAccountId, req.attemptStartedAt);
      return reconcileFromScan(scan, req);
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
    const org = creds.extra?.['organizationUrn'];
    if (!org) return names.map((n) => metricPoint(n, undefined, req.window));
    const param = req.remotePostId.startsWith('urn:li:ugcPost:') ? 'ugcPosts' : 'shares';
    const res = await this.rest(
      io,
      'GET',
      `/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(org)}&${param}=List(${encodeURIComponent(req.remotePostId)})`,
      creds.accessToken,
    );
    if (res.status !== 200) return names.map((n) => metricPoint(n, undefined, req.window));
    const stats = get(arr(get(res.json, 'elements'))[0], 'totalShareStatistics');
    // Lifetime totals as of fetch time (LinkedIn does not window per-share statistics): unit says so.
    return names.map((n) => metricPoint(n, num(get(stats, n)), req.window, { unit: 'lifetime_count' }));
  }

  async fetchAccountMetrics(
    req: { remoteAccountId: string; window: MetricWindow },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<RawMetricPoint[]> {
    const org = encodeURIComponent(orgUrn(req.remoteAccountId));
    const interval = `timeIntervals=(timeRange:(start:${Date.parse(req.window.start)},end:${Date.parse(req.window.end)}),timeGranularityType:DAY)`;
    const series = async (path: string): Promise<unknown[] | undefined> => {
      const res = await this.rest(io, 'GET', path, creds.accessToken);
      return res.status === 200 ? arr(get(res.json, 'elements')) : undefined;
    };
    const [followers, shares, pages] = await Promise.all([
      series(
        `/rest/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${org}&${interval}`,
      ),
      series(
        `/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${org}&${interval}`,
      ),
      series(`/rest/organizationPageStatistics?q=organization&organization=${org}&${interval}`),
    ]);
    const point = (name: string, elements: unknown[] | undefined): RawMetricPoint => {
      if (!elements) return metricPoint(name, undefined, req.window);
      const path = name.split('.');
      const points = elements
        .map((el) => ({ at: num(get(el, 'timeRange', 'start')), value: num(get(el, ...path)) }))
        .filter((p): p is { at: number; value: number } => p.at !== undefined && p.value !== undefined)
        .map((p) => ({ at: new Date(p.at).toISOString(), value: p.value }));
      const value = points.reduce((s, p) => s + p.value, 0);
      return metricPoint(name, points.length ? value : undefined, req.window, { series: points });
    };
    return this.capability.analytics.account.map((n) =>
      n.startsWith('followerGains.')
        ? point(n, followers)
        : n.startsWith('totalShareStatistics.')
          ? point(n, shares)
          : point(n, pages),
    );
  }

  async fetchComments(
    req: { remotePostId: string; since?: Date; cursor?: string },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<CommentPage> {
    const start = Number(req.cursor ?? '0') || 0;
    const count = 50;
    const res = await this.rest(
      io,
      'GET',
      `/rest/socialActions/${encodeURIComponent(req.remotePostId)}/comments?start=${start}&count=${count}`,
      creds.accessToken,
    );
    if (res.status !== 200) throw new Error(`linkedin comments failed: ${summarise(res, 200)}`);
    const elements = arr(get(res.json, 'elements'));
    const items = elements
      .map((c) => ({
        remoteCommentId: str(get(c, '$URN')) ?? str(get(c, 'id')) ?? '',
        authorHandle: str(get(c, 'actor')) ?? '',
        text: str(get(c, 'message', 'text')) ?? '',
        createdAt: new Date(num(get(c, 'created', 'time')) ?? 0).toISOString(),
        ...(str(get(c, 'parentComment')) ? { parentRemoteId: str(get(c, 'parentComment')) } : {}),
      }))
      .filter((c) => c.remoteCommentId && (!req.since || Date.parse(c.createdAt) >= req.since.getTime()));
    return { items, ...(elements.length === count ? { nextCursor: String(start + count) } : {}) };
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
    let serviceCode: number | undefined;
    try {
      serviceCode = num(get(JSON.parse(body), 'serviceErrorCode'));
    } catch {
      serviceCode = undefined;
    }
    const s = input.status;
    if (s === 401)
      return serviceCode === 65601 || /REVOKED/i.test(body)
        ? { kind: 'reconnect_required' }
        : { kind: 'refresh_token' };
    if (s === 403) return { kind: 'reconnect_required' };
    // LinkedIn throttles before processing the request (documented resource/application throttle limits).
    if (s === 429) return { kind: 'rate_limited', phase: 'before_send' };
    if (s >= 400 && s < 500) return { kind: 'rejected', code: `linkedin_${serviceCode ?? s}` };
    return { kind: 'unknown' };
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private async tokenRequest(io: ProviderIO, params: Record<string, string>): Promise<ProviderResponse> {
    const { res } = await io.request(
      `${LINKEDIN_OAUTH}/accessToken`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: formEncode(params),
      },
      { mutation: false },
    );
    return readResponse(res);
  }

  private async rest(
    io: ProviderIO,
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
    mutation = false,
  ): Promise<ProviderResponse> {
    const { res } = await io.request(
      `${LINKEDIN_API}${path}`,
      { method, headers: restHeaders(token), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      { mutation },
    );
    return readResponse(res);
  }

  private async administeredOrganisations(
    io: ProviderIO,
    token: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const res = await this.rest(
      io,
      'GET',
      '/rest/organizationAcls?q=roleAssignee&state=APPROVED&projection=(elements*(*,organization~(localizedName,vanityName)))',
      token,
    );
    if (res.status !== 200) throw new ProviderAuthError(this.key, 'identity_failed', summarise(res));
    return arr(get(res.json, 'elements'))
      .filter(
        (e) =>
          ['ADMINISTRATOR', 'CONTENT_ADMINISTRATOR'].includes(str(get(e, 'role')) ?? '') &&
          get(e, 'state') === 'APPROVED',
      )
      .map((e) => {
        const urn = str(get(e, 'organization')) ?? '';
        return { id: orgIdFrom(urn), name: str(get(e, 'organization~', 'localizedName')) ?? urn };
      })
      .filter((o) => o.id)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private async uploadMedia(
    io: ProviderIO,
    token: string,
    owner: string,
    m: PublishMedia,
    boundary: EffectBoundary,
  ): Promise<UploadedMedia | PublishOutcome> {
    const classify = (i: Parameters<ProviderAdapter['classifyError']>[0]): ProviderErrorClass =>
      this.classifyError(i);
    const bytes = await fetchBytes(io, m.url);
    const isVideo = m.mime.startsWith('video/');
    const init = await this.rest(
      io,
      'POST',
      `/rest/${isVideo ? 'videos' : 'images'}?action=initializeUpload`,
      token,
      {
        initializeUploadRequest: {
          owner,
          ...(isVideo
            ? { fileSizeBytes: bytes.byteLength, uploadCaptions: false, uploadThumbnail: false }
            : {}),
        },
      },
      true,
    );
    if (init.status !== 200) return outcomeFromResponse(classify, init, boundary);
    const urn = str(get(init.json, 'value', isVideo ? 'video' : 'image'));
    if (!urn)
      return { outcome: 'retryable_error', code: 'upload_init_malformed', message: summarise(init, 200) };
    const put = async (url: string, body: Uint8Array): Promise<ProviderResponse> => {
      const { res } = await io.request(
        url,
        { method: 'PUT', headers: { ...bearer(token), 'content-type': 'application/octet-stream' }, body },
        { mutation: true },
      );
      return readResponse(res);
    };
    if (!isVideo) {
      const uploadUrl = str(get(init.json, 'value', 'uploadUrl'));
      if (!uploadUrl)
        return { outcome: 'retryable_error', code: 'upload_init_malformed', message: summarise(init, 200) };
      const res = await put(uploadUrl, bytes);
      if (res.status >= 300) return outcomeFromResponse(classify, res, boundary);
      return { urn, kind: 'image', ...(m.altText ? { altText: m.altText } : {}) };
    }
    // Videos: one PUT per uploadInstructions part, ETags collected, then finalizeUpload.
    const etags: string[] = [];
    for (const part of arr(get(init.json, 'value', 'uploadInstructions'))) {
      const uploadUrl = str(get(part, 'uploadUrl'));
      const first = num(get(part, 'firstByte')) ?? 0;
      const last = num(get(part, 'lastByte')) ?? bytes.byteLength - 1;
      if (!uploadUrl)
        return { outcome: 'retryable_error', code: 'upload_init_malformed', message: summarise(init, 200) };
      const res = await put(uploadUrl, bytes.subarray(first, last + 1));
      if (res.status >= 300) return outcomeFromResponse(classify, res, boundary);
      etags.push(res.headers.get('etag') ?? '');
    }
    const fin = await this.rest(
      io,
      'POST',
      '/rest/videos?action=finalizeUpload',
      token,
      {
        finalizeUploadRequest: {
          video: urn,
          uploadToken: str(get(init.json, 'value', 'uploadToken')) ?? '',
          uploadedPartIds: etags,
        },
      },
      true,
    );
    if (fin.status >= 300) return outcomeFromResponse(classify, fin, boundary);
    return { urn, kind: 'video' };
  }

  private postsCreate(
    io: ProviderIO,
    token: string,
    authorUrn: string,
    commentary: string,
    media: readonly UploadedMedia[],
  ): Promise<ProviderResponse> {
    const content =
      media.length === 0
        ? {}
        : media.length === 1 && media[0]
          ? {
              content: {
                media: { id: media[0].urn, ...(media[0].altText ? { altText: media[0].altText } : {}) },
              },
            }
          : {
              content: {
                multiImage: {
                  images: media.map((m) => ({ id: m.urn, ...(m.altText ? { altText: m.altText } : {}) })),
                },
              },
            };
    return this.rest(
      io,
      'POST',
      '/rest/posts',
      token,
      {
        author: authorUrn,
        commentary,
        visibility: 'PUBLIC',
        distribution: {
          feedDistribution: 'MAIN_FEED',
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        ...content,
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      },
      true,
    );
  }

  private async createPost(
    io: ProviderIO,
    token: string,
    authorUrn: string,
    commentary: string,
    media: readonly UploadedMedia[],
    boundary: EffectBoundary,
  ): Promise<PublishOutcome> {
    boundary.cross();
    const res = await this.postsCreate(io, token, authorUrn, commentary, media);
    if (res.status !== 201 && res.status !== 200)
      return outcomeFromResponse(
        (i) => this.classifyError(i),
        res,
        boundary,
        (h) => (h.get('retry-after') ? retryAfterMs(h.get('retry-after')) : undefined),
      );
    const id = res.headers.get('x-restli-id');
    if (!id)
      return { outcome: 'unknown', code: 'missing_post_id', message: 'LinkedIn returned no x-restli-id' };
    return { outcome: 'accepted', remotePostId: id, remoteUrl: postUrl(id) };
  }

  /** Find-by-author scan, newest first; `covered` when the page reached posts older than the attempt or ran short. */
  private async scanRecent(
    io: ProviderIO,
    token: string,
    remoteAccountId: string,
    since: Date,
  ): Promise<{ posts: RecentPost[]; covered: boolean; reason?: string }> {
    const posts: RecentPost[] = [];
    const notBefore = since.getTime() - 5 * 60_000;
    for (let page = 0; page < SCAN_PAGES; page += 1) {
      const res = await this.rest(
        io,
        'GET',
        `/rest/posts?author=${encodeURIComponent(orgUrn(remoteAccountId))}&q=author&count=${SCAN_PAGE}&start=${page * SCAN_PAGE}&sortBy=LAST_MODIFIED`,
        token,
      );
      if (res.status !== 200) return { posts, covered: false, reason: `scan_http_${res.status}` };
      const elements = arr(get(res.json, 'elements'));
      for (const el of elements) {
        const id = str(get(el, 'id'));
        if (!id) continue;
        posts.push({
          id,
          text: str(get(el, 'commentary')),
          createdAt: num(get(el, 'createdAt')),
          url: postUrl(id),
        });
      }
      if (
        elements.length < SCAN_PAGE ||
        posts.some((p) => p.createdAt !== undefined && p.createdAt < notBefore)
      )
        return { posts, covered: true };
    }
    return { posts, covered: false, reason: 'scan_pages_exhausted' };
  }

  private async completedPost(
    io: ProviderIO,
    token: string,
    data: PendingData,
  ): Promise<PendingCheck | undefined> {
    const scan = await this.scanRecent(io, token, data.remoteAccountId, new Date(data.attemptStartedAt));
    const r = reconcileFromScan(scan, {
      attemptStartedAt: new Date(data.attemptStartedAt),
      textFingerprint: data.textFingerprint || textFingerprint(data.commentary),
    });
    return r.status === 'found'
      ? { status: 'completed', remotePostId: r.remotePostId, remoteUrl: r.remoteUrl }
      : undefined;
  }
}

export const linkedInPageAdapter = new LinkedInPageAdapter();
