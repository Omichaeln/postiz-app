import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials, PendingState } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../testing';
import { missingScopes } from '../base';
import { textFingerprint } from '../shared';
import type { ProviderAdapter, PublishRequest } from '../contract';
import { facebookPageAdapter as adapter } from './adapter';

const fx = (file: string, name: string) =>
  loadScenario(new URL(`./fixtures/${file}.json`, import.meta.url), name);
const TEXT = 'Hello from Oremedia #launch';
const client = { clientId: 'cid', clientSecret: 'csecret' };
const creds: DecryptedCredentials = {
  accessToken: 'page_100_fake',
  extra: { pageId: 'p_100', userAccessToken: 'long_user_fake' },
};
const request = (media: PublishRequest['media'] = []): PublishRequest => ({
  publicationId: 'pub_1',
  attemptId: 'att_1',
  idempotencyKey: 'att_1',
  remoteAccountId: 'p_100',
  text: TEXT,
  media,
  settings: {},
  textFingerprint: textFingerprint(TEXT),
  mediaFingerprints: media.map((m) => m.contentHash),
});
const img1 = {
  url: 'https://media.oremedia.test/release/img1.jpg',
  mime: 'image/jpeg',
  width: 1200,
  height: 630,
  bytes: 20,
  altText: 'A launch banner',
  contentHash: 'h1',
};
const img2 = {
  url: 'https://media.oremedia.test/release/img2.jpg',
  mime: 'image/jpeg',
  width: 1200,
  height: 630,
  bytes: 20,
  contentHash: 'h2',
};
const clip = {
  url: 'https://media.oremedia.test/release/clip.mp4',
  mime: 'video/mp4',
  width: 1920,
  height: 1080,
  bytes: 100,
  contentHash: 'h3',
};
const pendingState = (): PendingState => ({
  remoteJobId: 'vid_77',
  data: {
    v: 1,
    kind: 'video',
    pageId: 'p_100',
    videoId: 'vid_77',
    textFingerprint: textFingerprint(TEXT),
    attemptStartedAt: '2026-09-24T00:00:00.000Z',
  },
});

describe('Facebook Page adapter (spec 14.5, 14.8)', () => {
  const server = new FixtureServer();
  let io: FixtureIO;
  beforeAll(async () => {
    await server.start();
    io = await fixtureIO(server, { providerKey: adapter.key });
  });
  afterAll(() => server.stop());
  const load = (file: string, name: string): void => {
    server.load(fx(file, name));
    io.calls.length = 0;
  };

  it('authorizationUrl: Facebook Login dialog with comma-separated scopes and state', async () => {
    const u = new URL(
      (
        await adapter.authorizationUrl({
          state: 'st',
          codeVerifier: 'v',
          redirectUri: 'https://app.test/cb',
          client,
        })
      ).url,
    );
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v25.0/dialog/oauth');
    expect(u.searchParams.get('scope')).toBe(adapter.capability.requiredScopes.join(','));
    expect(u.searchParams.get('state')).toBe('st');
  });

  it('exchangeCode: short → long-lived token, permissions, pages sorted with page token and alternatives; missing scope surfaced', async () => {
    load('auth', 'exchange');
    const grant = await adapter.exchangeCode(
      { code: 'code_1', codeVerifier: 'v', redirectUri: 'https://app.test/cb', client },
      io,
    );
    expect(grant.remoteAccountId).toBe('p_100');
    expect(grant.credentials.accessToken).toBe('page_100_fake');
    expect(grant.credentials.extra).toEqual({ pageId: 'p_100', userAccessToken: 'long_user_fake' });
    expect(grant.alternatives).toEqual([{ remoteAccountId: 'p_200', displayName: 'Tar Studio' }]);
    expect(missingScopes(adapter.capability.requiredScopes, grant.grantedScopes)).toEqual([
      'business_management',
    ]);
    // token exchanges are effecting (the code is spent, a new token is issued); graph reads are not
    expect(
      io.calls.every((c) => c.mutation === new URL(c.url).pathname.endsWith('/oauth/access_token')),
    ).toBe(true);
    expect(io.calls.filter((c) => c.mutation)).toHaveLength(2);
    expect(server.remaining()).toEqual([]);
  });

  it('refresh: re-exchanges the user token and re-reads the page token; code 190 → reconnect_required', async () => {
    load('auth', 'refresh_ok');
    expect(await adapter.refresh(creds, client, io)).toMatchObject({
      ok: true,
      credentials: {
        accessToken: 'page_100_2_fake',
        extra: { userAccessToken: 'long_user_2_fake' },
      },
    });
    expect(io.calls.map((c) => `${c.mutation ? 'M' : 'R'} ${c.method}`)).toEqual(['M GET', 'R GET']);
    load('auth', 'refresh_revoked');
    expect(await adapter.refresh(creds, client, io)).toEqual({ ok: false, reason: 'reconnect_required' });
  });

  it('validateVariant: 4 MB photo cap, mime, count, mixed media, alt text', () => {
    const img = { mime: 'image/jpeg', width: 1200, height: 630, bytes: 1000 };
    expect(adapter.validateVariant({ text: TEXT, altTexts: [], media: [img], settings: {} }).ok).toBe(true);
    const issues = adapter
      .validateVariant({
        text: 'x'.repeat(63_207),
        altTexts: [''],
        media: [
          { ...img, bytes: 5 * 1024 * 1024 },
          { ...img, mime: 'image/tiff' },
          ...Array.from({ length: 9 }, () => img),
        ],
        settings: { requireAltText: true },
      })
      .issues.map((i) => i.issue);
    expect(issues.some((i) => i.startsWith('text_too_long'))).toBe(true);
    expect(issues).toContain('image_too_large');
    expect(issues).toContain('mime_not_supported:image/tiff');
    expect(issues.some((i) => i.startsWith('too_many_images'))).toBe(true);
    expect(issues).toContain('alt_text_missing');
    expect(
      adapter
        .validateVariant({
          text: '',
          altTexts: [],
          media: [img, { mime: 'video/mp4', width: 1, height: 1, bytes: 1 }],
          settings: {},
        })
        .issues.map((i) => i.issue),
    ).toContain('mixed_media_not_supported');
  });

  it('publish: text → /feed accepted with permalink; photos → unpublished uploads then one feed post (permalink failure is cosmetic)', async () => {
    load('publish', 'text_success');
    expect(await adapter.publish(request(), creds, io)).toEqual({
      outcome: 'accepted',
      remotePostId: 'p_100_5001',
      remoteUrl: 'https://www.facebook.com/p_100/posts/5001',
    });
    expect(io.calls.map((c) => `${c.mutation ? 'M' : 'R'} ${c.method}`)).toEqual(['M POST', 'R GET']);
    load('publish', 'photos_success');
    expect(await adapter.publish(request([img1, img2]), creds, io)).toEqual({
      outcome: 'accepted',
      remotePostId: 'p_100_5002',
      remoteUrl: 'https://www.facebook.com/p_100_5002',
    });
    expect(server.remaining()).toEqual([]);
  });

  it('publish (video): the post is created and reported pending until processing finishes; no finalize member', async () => {
    load('publish', 'video_pending');
    const out = await adapter.publish(request([clip]), creds, io);
    expect(out).toMatchObject({
      outcome: 'pending',
      remoteJobId: 'vid_77',
      pending: { data: { kind: 'video', videoId: 'vid_77' } },
    });
    expect((adapter as ProviderAdapter).finalize).toBeUndefined();
    load('pending', 'check_processing');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toMatchObject({ status: 'processing' });
    load('pending', 'check_completed');
    for (let i = 0; i < 2; i += 1)
      expect(await adapter.checkStatus(pendingState(), creds, io)).toEqual({
        status: 'completed',
        remotePostId: 'vid_77',
        remoteUrl: 'https://www.facebook.com/p_100/videos/vid_77/',
      });
    load('pending', 'check_failed');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toMatchObject({
      status: 'failed',
      code: 'video_processing_failed',
    });
  });

  it('outcome classification table (Meta error codes)', async () => {
    const table: Array<[string, PublishRequest['media'], Record<string, unknown>]> = [
      ['rejected_validation', [], { outcome: 'rejected', code: 'meta_100_1349125' }],
      ['rate_limited', [], { outcome: 'retryable_error', code: 'rate_limited', retryAfterMs: 120_000 }],
      ['expired_token', [], { outcome: 'retryable_error', code: 'refresh_token' }],
      ['revoked_token', [], { outcome: 'rejected', code: 'reconnect_required' }],
      ['server_error_after_send', [], { outcome: 'unknown' }],
      ['timeout_after_send', [], { outcome: 'unknown', code: 'transport_after_send' }],
      ['photo_upload_5xx', [img1], { outcome: 'retryable_error', code: 'pre_publish_http_503' }],
    ];
    for (const [scenario, media, expected] of table) {
      load('publish', scenario);
      expect(await adapter.publish(request(media), creds, io), scenario).toMatchObject(expected);
    }
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(await adapter.publish(request([img1]), creds, refused)).toMatchObject({
      outcome: 'retryable_error',
      code: 'transport_before_publish',
    });
    expect(await adapter.publish(request(), creds, refused)).toMatchObject({
      outcome: 'retryable_error',
      code: 'transport_before_send',
    });
    expect(adapter.classifyError({ status: 429, body: '', phase: 'after_send' })).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
    });
    expect(adapter.classifyError({ status: 500, body: '', phase: 'after_send' })).toEqual({
      kind: 'unknown',
    });
  });

  it('findRemotePost: found / definitely_absent (since-bounded scan exhausted) / cannot_determine (page budget)', async () => {
    const req = {
      publicationId: 'pub_1',
      attemptStartedAt: new Date('2026-09-24T00:00:00.000Z'),
      textFingerprint: textFingerprint(TEXT),
      mediaFingerprints: [],
      remoteAccountId: 'p_100',
    };
    load('reconcile', 'found');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({
      status: 'found',
      remotePostId: 'p_100_5009',
      remoteUrl: 'https://www.facebook.com/p_100/posts/5009',
      matchedBy: 'fingerprint',
    });
    expect(server.requests[0]?.query['since']).toBe(
      String(Math.floor(Date.parse('2026-09-23T23:55:00.000Z') / 1000)),
    );
    load('reconcile', 'absent');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({ status: 'definitely_absent' });
    load('reconcile', 'cannot_determine');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({
      status: 'cannot_determine',
      reason: 'scan_pages_exhausted',
    });
  });

  it('metrics: lifetime post points, daily account series with breakdown sums; comments page with cursor; reply', async () => {
    const window = { start: '2026-09-21T00:00:00.000Z', end: '2026-09-23T00:00:00.000Z' };
    load('read', 'post_metrics');
    const post = await adapter.fetchPostMetrics({ remotePostId: 'p_100_5001', window }, creds, io);
    expect(post.find((p) => p.nativeName === 'post_reactions_by_type_total')).toMatchObject({
      value: 34,
      completeness: 'complete',
    });
    expect(post.find((p) => p.nativeName === 'post_clicks_by_type')).toMatchObject({
      value: null,
      completeness: 'unavailable',
    });
    load('read', 'account_metrics');
    const account = await adapter.fetchAccountMetrics({ remoteAccountId: 'p_100', window }, creds, io);
    expect(account.find((p) => p.nativeName === 'page_daily_follows')).toMatchObject({
      value: 8,
      series: [
        { at: '2026-09-22T07:00:00+0000', value: 3 },
        { at: '2026-09-23T07:00:00+0000', value: 5 },
      ],
    });
    expect(account.find((p) => p.nativeName === 'page_media_view')).toMatchObject({ value: 100 });
    load('read', 'comments_page');
    const page = await adapter.fetchComments({ remotePostId: 'p_100_5001' }, creds, io);
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({ parentRemoteId: 'c_1', authorHandle: 'Ore Media' });
    expect(page.nextCursor).toBe('aft_2');
    load('read', 'comment_reply');
    expect(
      await adapter.comment({ remotePostId: 'c_1', text: 'Thanks Bea', idempotencyKey: 'k' }, creds, io),
    ).toEqual({ outcome: 'accepted', remotePostId: 'c_3', remoteUrl: 'https://www.facebook.com/c_3' });
  });
});
