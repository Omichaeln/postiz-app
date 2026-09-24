import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials, PendingState } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO, type FixtureScenario } from '../testing';
import { missingScopes } from '../base';
import { AmbiguousMutationError, textFingerprint } from '../shared';
import type { PublishRequest } from '../contract';
import { xAdapter as adapter } from './adapter';
import { weightedLength } from './text';

const fx = (file: string, name: string): FixtureScenario => {
  const s = loadScenario(new URL(`./fixtures/${file}.json`, import.meta.url), name);
  const reset = String(Math.floor(Date.now() / 1000) + 45);
  for (const e of s.exchanges)
    if (e.response?.headers)
      for (const k of Object.keys(e.response.headers))
        if (e.response.headers[k] === 'RESET_EPOCH') e.response.headers[k] = reset;
  return s;
};
const TEXT = 'Hello from Oremedia #launch';
const client = { clientId: 'cid', clientSecret: 'csecret' };
const creds: DecryptedCredentials = {
  accessToken: 'xat_1_fake',
  refreshToken: 'xrt_1_fake',
  extra: { username: 'oremedia' },
};
const img1 = {
  url: 'https://media.oremedia.test/release/img1.jpg',
  mime: 'image/jpeg',
  width: 1200,
  height: 675,
  bytes: 20,
  altText: 'A launch banner',
  contentHash: 'h1',
};
const clip = {
  url: 'https://media.oremedia.test/release/clip.mp4',
  mime: 'video/mp4',
  width: 1280,
  height: 720,
  bytes: 8,
  contentHash: 'h3',
};
const request = (media: PublishRequest['media'] = [], text = TEXT): PublishRequest => ({
  publicationId: 'pub_1',
  attemptId: 'att_1',
  idempotencyKey: 'att_1',
  remoteAccountId: 'u_42',
  text,
  media,
  settings: {},
  textFingerprint: textFingerprint(text),
  mediaFingerprints: media.map((m) => m.contentHash),
});
const pendingState = (): PendingState => ({
  remoteJobId: 'm_v',
  data: {
    v: 1,
    userId: 'u_42',
    username: 'oremedia',
    text: TEXT,
    mediaIds: ['m_v'],
    processingIds: ['m_v'],
    textFingerprint: textFingerprint(TEXT),
    attemptStartedAt: '2026-09-24T00:00:00.000Z',
  },
});
const COMPLETED = {
  status: 'completed',
  remotePostId: '1900000000000000003',
  remoteUrl: 'https://x.com/oremedia/status/1900000000000000003',
};

describe('X adapter (spec 14.5, 14.8; D-04 open, X built as the fourth channel)', () => {
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

  it('measureText: weighted counting (URLs 23, CJK and emoji 2, Latin 1) against the 280 limit', () => {
    expect(weightedLength('hello')).toBe(5);
    expect(weightedLength('see https://oremedia.example/a/very/long/path/that/keeps/going ok')).toBe(
      4 + 23 + 3,
    );
    expect(weightedLength('日本語')).toBe(6);
    expect(weightedLength('🚀👨‍👩‍👧')).toBe(4);
    expect(weightedLength('oremedia.com today')).toBe(23 + 6);
    expect(adapter.measureText('x'.repeat(281))).toEqual({ length: 281, limit: 280 });
    expect(
      adapter.validateVariant({ text: '字'.repeat(141), altTexts: [], media: [], settings: {} }).issues[0]
        ?.issue,
    ).toBe('text_too_long:282>280');
  });

  it('authorizationUrl: PKCE S256 challenge derived from the verifier, scopes and state', async () => {
    const u = new URL(
      (
        await adapter.authorizationUrl({
          state: 'st',
          codeVerifier: 'verifier_xyz',
          redirectUri: 'https://app.test/cb',
          client,
        })
      ).url,
    );
    expect(u.origin + u.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('scope')).toBe('tweet.read tweet.write users.read offline.access media.write');
  });

  it('exchangeCode with the verifier and Basic client auth; refresh rotates the refresh token; invalid → reconnect_required', async () => {
    load('auth', 'exchange');
    const grant = await adapter.exchangeCode(
      { code: 'code_1', codeVerifier: 'verifier_xyz', redirectUri: 'https://app.test/cb', client },
      io,
    );
    expect(grant).toMatchObject({
      remoteAccountId: 'u_42',
      displayName: 'Ore Media',
      credentials: {
        accessToken: 'xat_1_fake',
        refreshToken: 'xrt_1_fake',
        extra: { username: 'oremedia' },
      },
    });
    expect(server.requests[0]?.headers['authorization']).toBe(
      `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
    );
    expect(missingScopes(adapter.capability.requiredScopes, grant.grantedScopes)).toEqual([]);
    load('auth', 'refresh_ok');
    expect(await adapter.refresh(creds, client, io)).toMatchObject({
      ok: true,
      credentials: { accessToken: 'xat_2_fake', refreshToken: 'xrt_2_fake' },
    });
    load('auth', 'refresh_revoked');
    expect(await adapter.refresh(creds, client, io)).toEqual({ ok: false, reason: 'reconnect_required' });
  });

  it('validateVariant: 4 images max, 5 MB images / 15 MB GIF alone, no mixing, alt text', () => {
    const img = { mime: 'image/png', width: 800, height: 600, bytes: 1000 };
    expect(
      adapter.validateVariant({ text: TEXT, altTexts: [], media: [img, img, img, img], settings: {} }).ok,
    ).toBe(true);
    const issues = adapter
      .validateVariant({
        text: TEXT,
        altTexts: ['', '', '', '', ''],
        media: [img, img, img, img, { ...img, bytes: 6 * 1024 * 1024 }],
        settings: { requireAltText: true },
      })
      .issues.map((i) => i.issue);
    expect(issues.some((i) => i.startsWith('too_many_images'))).toBe(true);
    expect(issues).toContain('image_too_large');
    expect(issues).toContain('alt_text_missing');
    expect(
      adapter.validateVariant({
        text: 'a',
        altTexts: [],
        media: [{ ...img, mime: 'image/gif', bytes: 10 * 1024 * 1024 }],
        settings: {},
      }).ok,
    ).toBe(true);
    expect(
      adapter
        .validateVariant({
          text: 'a',
          altTexts: [],
          media: [{ ...img, mime: 'image/gif' }, img],
          settings: {},
        })
        .issues.map((i) => i.issue),
    ).toContain('gif_must_be_alone');
    expect(
      adapter
        .validateVariant({
          text: 'a',
          altTexts: [],
          media: [img, { mime: 'video/mp4', width: 1, height: 1, bytes: 1, durationMs: 1000 }],
          settings: {},
        })
        .issues.map((i) => i.issue),
    ).toContain('mixed_media_not_supported');
  });

  it('publish: text → accepted; image → INIT/APPEND/FINALIZE + alt text metadata then the post; video → pending while transcoding', async () => {
    load('publish', 'text_success');
    expect(await adapter.publish(request(), creds, io)).toEqual({
      outcome: 'accepted',
      remotePostId: '1900000000000000001',
      remoteUrl: 'https://x.com/oremedia/status/1900000000000000001',
    });
    load('publish', 'image_success');
    expect(await adapter.publish(request([img1]), creds, io)).toMatchObject({
      outcome: 'accepted',
      remotePostId: '1900000000000000002',
    });
    expect(io.calls.map((c) => `${c.mutation ? 'M' : 'R'} ${new URL(c.url).pathname}`)).toEqual([
      'R /release/img1.jpg',
      'M /2/media/upload/initialize',
      'M /2/media/upload/m_1/append',
      'M /2/media/upload/m_1/finalize',
      'M /2/media/metadata',
      'M /2/tweets',
    ]);
    expect(server.remaining()).toEqual([]);
    load('publish', 'video_pending');
    expect(await adapter.publish(request([clip]), creds, io)).toMatchObject({
      outcome: 'pending',
      remoteJobId: 'm_v',
      pending: { data: { mediaIds: ['m_v'], processingIds: ['m_v'] } },
    });
  });

  it('outcome classification table (X problem types, rate-limit reset header)', async () => {
    const table: Array<[string, PublishRequest['media'], Record<string, unknown>]> = [
      ['rejected_validation', [], { outcome: 'rejected', code: 'x_invalid_request' }],
      ['duplicate', [], { outcome: 'rejected', code: 'duplicate_content' }],
      ['rate_limited', [], { outcome: 'retryable_error', code: 'rate_limited' }],
      ['expired_token', [], { outcome: 'retryable_error', code: 'refresh_token' }],
      ['suspended', [], { outcome: 'rejected', code: 'reconnect_required' }],
      ['server_error_after_send', [], { outcome: 'unknown' }],
      ['timeout_after_send', [], { outcome: 'unknown', code: 'transport_after_send' }],
      ['upload_init_429', [img1], { outcome: 'retryable_error', code: 'rate_limited' }],
    ];
    for (const [scenario, media, expected] of table) {
      load('publish', scenario);
      const out = await adapter.publish(request(media), creds, io);
      expect(out, scenario).toMatchObject(expected);
      if (expected['code'] === 'rate_limited') {
        const ms = (out as { retryAfterMs?: number }).retryAfterMs ?? 0;
        expect(ms, scenario).toBeGreaterThan(30_000);
        expect(ms, scenario).toBeLessThanOrEqual(46_000);
      }
    }
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(await adapter.publish(request([img1]), creds, refused)).toMatchObject({
      outcome: 'retryable_error',
      code: 'transport_before_publish',
    });
    expect(adapter.classifyError({ status: 429, body: '', phase: 'after_send' })).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
    });
    expect(
      adapter.classifyError({
        status: 403,
        body: '{"type":"https://api.twitter.com/2/problems/client-not-enrolled"}',
        phase: 'after_send',
      }),
    ).toEqual({ kind: 'reconnect_required' });
  });

  it('checkStatus: STATUS polling with check_after_secs, ready when succeeded, failed on failure', async () => {
    load('pending', 'check_processing');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toEqual({
      status: 'processing',
      retryAfterMs: 7000,
    });
    load('pending', 'check_ready');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toEqual({ status: 'ready' });
    load('pending', 'check_failed');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toMatchObject({
      status: 'failed',
      code: 'media_processing_failed',
      message: 'Unsupported video format',
    });
    expect(io.calls.every((c) => !c.mutation)).toBe(true);
  });

  it('finalize creates the post; checkStatus afterwards is completed, never ready (spec 20.3); duplicate → found; 5xx → ambiguous', async () => {
    load('pending', 'finalize_completed');
    expect(await adapter.finalize(pendingState(), creds, io)).toEqual(COMPLETED);
    load('pending', 'check_after_finalize');
    for (let i = 0; i < 3; i += 1)
      expect(await adapter.checkStatus(pendingState(), creds, io)).toEqual(COMPLETED);
    expect(io.calls.some((c) => c.mutation)).toBe(false);
    load('pending', 'finalize_duplicate_then_found');
    expect(await adapter.finalize(pendingState(), creds, io)).toEqual(COMPLETED);
    load('pending', 'finalize_5xx');
    await expect(adapter.finalize(pendingState(), creds, io)).rejects.toBeInstanceOf(AmbiguousMutationError);
  });

  it('findRemotePost: found through t.co restoration / definitely_absent / cannot_determine', async () => {
    const text = 'Read more at https://oremedia.example/launch today';
    const req = {
      publicationId: 'pub_1',
      attemptStartedAt: new Date('2026-09-24T00:00:00.000Z'),
      textFingerprint: textFingerprint(text),
      mediaFingerprints: [],
      remoteAccountId: 'u_42',
    };
    load('reconcile', 'found_with_tco');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({
      status: 'found',
      remotePostId: '1900000000000000010',
      remoteUrl: 'https://x.com/i/web/status/1900000000000000010',
      matchedBy: 'fingerprint',
    });
    expect(server.requests[0]?.query['start_time']).toBe('2026-09-23T23:55:00.000Z');
    load('reconcile', 'absent');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({ status: 'definitely_absent' });
    load('reconcile', 'cannot_determine');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({
      status: 'cannot_determine',
      reason: 'scan_http_429',
    });
  });

  it('metrics: public + non-public with fallback to public only; account snapshot; replies via search with handles; reply', async () => {
    const window = { start: '2026-09-21T00:00:00.000Z', end: '2026-09-23T00:00:00.000Z' };
    load('read', 'post_metrics');
    const post = await adapter.fetchPostMetrics({ remotePostId: '1900000000000000001', window }, creds, io);
    expect(post.find((p) => p.nativeName === 'impression_count')).toMatchObject({ value: 2100 });
    expect(post.find((p) => p.nativeName === 'url_link_clicks')).toMatchObject({ value: 17 });
    load('read', 'post_metrics_public_only');
    const pub = await adapter.fetchPostMetrics({ remotePostId: '1900000000000000001', window }, creds, io);
    expect(pub.find((p) => p.nativeName === 'url_link_clicks')).toMatchObject({
      value: null,
      completeness: 'unavailable',
    });
    expect(pub.find((p) => p.nativeName === 'like_count')).toMatchObject({ value: 31 });
    load('read', 'account_metrics');
    expect(
      (await adapter.fetchAccountMetrics({ remoteAccountId: 'u_42', window }, creds, io)).find(
        (p) => p.nativeName === 'followers_count',
      ),
    ).toMatchObject({ value: 1200 });
    load('read', 'comments_page');
    const page = await adapter.fetchComments({ remotePostId: '1900000000000000001' }, creds, io);
    expect(page.items).toEqual([
      {
        remoteCommentId: '1900000000000000020',
        authorHandle: 'bea',
        text: '@oremedia congrats',
        createdAt: '2026-09-24T01:00:00.000Z',
        parentRemoteId: '1900000000000000001',
      },
      {
        remoteCommentId: '1900000000000000021',
        authorHandle: 'oremedia',
        text: 'thanks!',
        createdAt: '2026-09-24T01:05:00.000Z',
        parentRemoteId: '1900000000000000020',
      },
    ]);
    expect(page.nextCursor).toBe('nt_1');
    load('read', 'comment_reply');
    expect(
      await adapter.comment(
        { remotePostId: '1900000000000000020', text: 'Thank you Bea', idempotencyKey: 'k' },
        creds,
        io,
      ),
    ).toEqual({
      outcome: 'accepted',
      remotePostId: '1900000000000000022',
      remoteUrl: 'https://x.com/oremedia/status/1900000000000000022',
    });
  });
});
