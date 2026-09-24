import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials, PendingState } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../testing';
import { missingScopes } from '../base';
import { AmbiguousMutationError, textFingerprint } from '../shared';
import type { PublishRequest } from '../contract';
import { instagramBusinessAdapter as adapter } from './adapter';

const fx = (file: string, name: string) =>
  loadScenario(new URL(`./fixtures/${file}.json`, import.meta.url), name);
const TEXT = 'Hello from Oremedia #launch';
const client = { clientId: 'cid', clientSecret: 'csecret' };
const creds: DecryptedCredentials = {
  accessToken: 'long_user_fake',
  extra: { igUserId: 'ig_900', pageId: 'p_100', igUsername: 'oremedia' },
};
const img1 = {
  url: 'https://media.oremedia.test/release/img1.jpg',
  mime: 'image/jpeg',
  width: 1080,
  height: 1350,
  bytes: 20,
  altText: 'A launch banner',
  contentHash: 'h1',
};
const clip = {
  url: 'https://media.oremedia.test/release/clip.mp4',
  mime: 'video/mp4',
  width: 1080,
  height: 1920,
  bytes: 100,
  contentHash: 'h3',
};
const request = (media: PublishRequest['media']): PublishRequest => ({
  publicationId: 'pub_1',
  attemptId: 'att_1',
  idempotencyKey: 'att_1',
  remoteAccountId: 'ig_900',
  text: TEXT,
  media,
  settings: {},
  textFingerprint: textFingerprint(TEXT),
  mediaFingerprints: media.map((m) => m.contentHash),
});
const pendingState = (): PendingState => ({
  containerId: 'ctn_1',
  data: {
    v: 1,
    igUserId: 'ig_900',
    containerId: 'ctn_1',
    kind: 'image',
    caption: TEXT,
    textFingerprint: textFingerprint(TEXT),
    attemptStartedAt: '2026-09-24T00:00:00.000Z',
    username: 'oremedia',
  },
});
const COMPLETED = {
  status: 'completed',
  remotePostId: 'media_555',
  remoteUrl: 'https://www.instagram.com/p/AbCdEf/',
};

describe('Instagram Business adapter (spec 14.5, 14.8, 20.3)', () => {
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

  it('exchangeCode: only pages with a connected Instagram account are eligible; user token kept; all scopes granted', async () => {
    load('auth', 'exchange');
    const grant = await adapter.exchangeCode(
      { code: 'code_1', codeVerifier: 'v', redirectUri: 'https://app.test/cb', client },
      io,
    );
    expect(grant).toMatchObject({ remoteAccountId: 'ig_900', displayName: '@oremedia', alternatives: [] });
    expect(grant.credentials).toEqual({
      accessToken: 'long_user_fake',
      expiresAt: expect.any(String),
      extra: { igUserId: 'ig_900', pageId: 'p_100', igUsername: 'oremedia' },
    });
    expect(missingScopes(adapter.capability.requiredScopes, grant.grantedScopes)).toEqual([]);
    expect(server.remaining()).toEqual([]);
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
    expect(u.searchParams.get('scope')).toContain('instagram_content_publish');
  });

  it('refresh: long-lived token re-exchange; password change (190/460) → reconnect_required', async () => {
    load('auth', 'refresh_ok');
    expect(await adapter.refresh(creds, client, io)).toMatchObject({
      ok: true,
      credentials: { accessToken: 'long_user_2_fake', extra: creds.extra },
    });
    load('auth', 'refresh_revoked');
    expect(await adapter.refresh(creds, client, io)).toEqual({ ok: false, reason: 'reconnect_required' });
  });

  it('validateVariant: media required, JPEG only, 4:5–1.91:1 aspect ratio, carousel ≤ 10, alt text', () => {
    const ok = { mime: 'image/jpeg', width: 1080, height: 1350, bytes: 1000 };
    expect(adapter.validateVariant({ text: TEXT, altTexts: ['alt'], media: [ok], settings: {} }).ok).toBe(
      true,
    );
    expect(
      adapter
        .validateVariant({ text: TEXT, altTexts: [], media: [], settings: {} })
        .issues.map((i) => i.issue),
    ).toContain('media_required');
    const issues = adapter
      .validateVariant({
        text: 'x'.repeat(2201),
        altTexts: [],
        media: [
          { ...ok, mime: 'image/png' },
          { ...ok, width: 1080, height: 2000 },
          ...Array.from({ length: 9 }, () => ok),
        ],
        settings: {},
      })
      .issues.map((i) => i.issue);
    expect(issues).toContain('mime_not_supported:image/png');
    expect(issues.some((i) => i.startsWith('aspect_ratio_not_supported'))).toBe(true);
    expect(issues.some((i) => i.startsWith('too_many_images'))).toBe(true);
    expect(issues.some((i) => i.startsWith('text_too_long'))).toBe(true);
    expect(
      adapter
        .validateVariant({ text: 'a', altTexts: [''], media: [ok], settings: { requireAltText: true } })
        .issues.map((i) => i.issue),
    ).toContain('alt_text_missing');
  });

  it('publish: creates a container (single image with alt text; carousel with children) and returns pending; nothing is mutated after the boundary', async () => {
    load('publish', 'image_pending');
    const single = await adapter.publish(request([img1]), creds, io);
    expect(single).toMatchObject({
      outcome: 'pending',
      remoteJobId: 'ctn_1',
      pending: { containerId: 'ctn_1', data: { kind: 'image', igUserId: 'ig_900', username: 'oremedia' } },
    });
    load('publish', 'carousel_pending');
    const car = await adapter.publish(request([img1, clip]), creds, io);
    expect(car).toMatchObject({
      outcome: 'pending',
      pending: { containerId: 'ctn_car', data: { kind: 'carousel' } },
    });
    expect(io.calls.every((c) => c.mutation)).toBe(true);
    expect(server.remaining()).toEqual([]);
  });

  it('outcome classification table (all container creation is before the effect boundary)', async () => {
    const table: Array<[string, Record<string, unknown>]> = [
      ['rejected_validation', { outcome: 'rejected', code: 'meta_36003_2207009' }],
      ['rate_limited', { outcome: 'retryable_error', code: 'rate_limited', retryAfterMs: 60_000 }],
      ['expired_token', { outcome: 'retryable_error', code: 'refresh_token' }],
      ['revoked_token', { outcome: 'rejected', code: 'reconnect_required' }],
      ['container_5xx', { outcome: 'retryable_error', code: 'pre_publish_http_500' }],
      ['container_hang', { outcome: 'retryable_error', code: 'transport_before_publish' }],
    ];
    for (const [scenario, expected] of table) {
      load('publish', scenario);
      expect(await adapter.publish(request([img1]), creds, io), scenario).toMatchObject(expected);
    }
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(await adapter.publish(request([img1]), creds, refused)).toMatchObject({
      outcome: 'retryable_error',
      code: 'transport_before_publish',
    });
    expect(await adapter.publish(request([]), creds, io)).toMatchObject({
      outcome: 'rejected',
      code: 'media_required',
    });
  });

  it('checkStatus: IN_PROGRESS → processing, FINISHED → ready, ERROR/EXPIRED → failed', async () => {
    load('pending', 'check_in_progress');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toMatchObject({
      status: 'processing',
      retryAfterMs: 10_000,
    });
    load('pending', 'check_finished');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toEqual({ status: 'ready' });
    load('pending', 'check_error');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toMatchObject({
      status: 'failed',
      code: 'ig_container_error',
    });
    load('pending', 'check_expired');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toMatchObject({
      status: 'failed',
      code: 'ig_container_expired',
    });
    expect(io.calls.every((c) => !c.mutation)).toBe(true);
  });

  it('finalize publishes the container once; a PUBLISHED container is never published again; checkStatus then reports completed, never ready (spec 20.3)', async () => {
    load('pending', 'finalize_completed');
    expect(await adapter.finalize(pendingState(), creds, io)).toEqual(COMPLETED);
    expect(io.calls.filter((c) => c.mutation).map((c) => c.url)).toEqual([
      'https://graph.facebook.com/v25.0/ig_900/media_publish',
    ]);
    load('pending', 'finalize_already_published');
    expect(await adapter.finalize(pendingState(), creds, io)).toEqual(COMPLETED);
    expect(io.calls.some((c) => c.mutation)).toBe(false);
    load('pending', 'check_after_finalize');
    for (let i = 0; i < 3; i += 1)
      expect(await adapter.checkStatus(pendingState(), creds, io)).toEqual(COMPLETED);
    expect(io.calls.some((c) => c.mutation)).toBe(false);
  });

  it('finalize: not-ready subcode → processing; 5xx or timeout after media_publish was sent → AmbiguousMutationError; refused → processing', async () => {
    load('pending', 'finalize_not_ready_subcode');
    expect(await adapter.finalize(pendingState(), creds, io)).toMatchObject({ status: 'processing' });
    load('pending', 'finalize_5xx');
    await expect(adapter.finalize(pendingState(), creds, io)).rejects.toBeInstanceOf(AmbiguousMutationError);
    load('pending', 'finalize_hang');
    await expect(adapter.finalize(pendingState(), creds, io)).rejects.toBeInstanceOf(AmbiguousMutationError);
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(await adapter.finalize(pendingState(), creds, refused)).toMatchObject({ status: 'processing' });
  });

  it('findRemotePost: found / definitely_absent / cannot_determine', async () => {
    const req = {
      publicationId: 'pub_1',
      attemptStartedAt: new Date('2026-09-24T00:00:00.000Z'),
      textFingerprint: textFingerprint(TEXT),
      mediaFingerprints: [],
      remoteAccountId: 'ig_900',
    };
    load('reconcile', 'found');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({
      status: 'found',
      remotePostId: 'media_556',
      remoteUrl: 'https://www.instagram.com/p/XyZ/',
      matchedBy: 'fingerprint',
    });
    load('reconcile', 'absent');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({ status: 'definitely_absent' });
    load('reconcile', 'cannot_determine');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({
      status: 'cannot_determine',
      reason: 'scan_http_400',
    });
  });

  it('metrics (lifetime post, daily/total account), comments with replies flattened and cursor, reply', async () => {
    const window = { start: '2026-09-21T00:00:00.000Z', end: '2026-09-23T00:00:00.000Z' };
    load('read', 'post_metrics');
    const post = await adapter.fetchPostMetrics({ remotePostId: 'media_555', window }, creds, io);
    expect(post.find((p) => p.nativeName === 'views')).toMatchObject({
      value: 900,
      completeness: 'complete',
    });
    expect(post.find((p) => p.nativeName === 'saved')).toMatchObject({
      value: null,
      completeness: 'unavailable',
    });
    load('read', 'account_metrics');
    const account = await adapter.fetchAccountMetrics({ remoteAccountId: 'ig_900', window }, creds, io);
    expect(account.find((p) => p.nativeName === 'follower_count')).toMatchObject({ value: 5 });
    expect(account.find((p) => p.nativeName === 'views')).toMatchObject({ value: 4200 });
    expect(account.find((p) => p.nativeName === 'shares')).toMatchObject({ completeness: 'unavailable' });
    load('read', 'comments_page');
    const page = await adapter.fetchComments({ remotePostId: 'media_555' }, creds, io);
    expect(page.items.map((i) => i.remoteCommentId)).toEqual(['ic_1', 'ic_2']);
    expect(page.items[1]).toMatchObject({ parentRemoteId: 'ic_1', authorHandle: 'oremedia' });
    expect(page.nextCursor).toBe('ig_after_1');
    load('read', 'comment_reply');
    expect(
      await adapter.comment(
        { remotePostId: 'media_555', text: 'Thanks all', idempotencyKey: 'k' },
        creds,
        io,
      ),
    ).toEqual({
      outcome: 'accepted',
      remotePostId: 'ic_3',
      remoteUrl: 'https://www.instagram.com/p/AbCdEf/',
    });
  });
});
