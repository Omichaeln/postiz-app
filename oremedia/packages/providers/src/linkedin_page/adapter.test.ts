import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecryptedCredentials, PendingState } from '@oremedia/contracts/providers';
import { FixtureServer, fixtureIO, loadScenario, type FixtureIO } from '../testing';
import { missingScopes } from '../base';
import { AmbiguousMutationError, textFingerprint } from '../shared';
import type { PublishRequest } from '../contract';
import { linkedInPageAdapter as adapter } from './adapter';

const fx = (file: string, name: string) =>
  loadScenario(new URL(`./fixtures/${file}.json`, import.meta.url), name);
const TEXT = 'Hello from Oremedia #launch';
const client = { clientId: 'cid', clientSecret: 'csecret' };
const creds: DecryptedCredentials = {
  accessToken: 'at_1_fake',
  refreshToken: 'rt_1_fake',
  extra: { organizationUrn: 'urn:li:organization:2001', memberSub: 'm_ada' },
};
const request = (media: PublishRequest['media'] = []): PublishRequest => ({
  publicationId: 'pub_1',
  attemptId: 'att_1',
  idempotencyKey: 'att_1',
  remoteAccountId: '2001',
  text: TEXT,
  media,
  settings: {},
  textFingerprint: textFingerprint(TEXT),
  mediaFingerprints: media.map((m) => m.contentHash),
});
const image = {
  url: 'https://media.oremedia.test/release/img1.jpg',
  mime: 'image/jpeg',
  width: 1200,
  height: 627,
  bytes: 20,
  altText: 'A launch banner',
  contentHash: 'h1',
};
const pendingState = (): PendingState => ({
  remoteJobId: 'urn:li:image:C4D_1',
  data: {
    v: 1,
    remoteAccountId: '2001',
    authorUrn: 'urn:li:organization:2001',
    commentary: TEXT,
    media: [{ urn: 'urn:li:image:C4D_1', kind: 'image', altText: 'A launch banner' }],
    textFingerprint: textFingerprint(TEXT),
    attemptStartedAt: '2026-09-24T00:00:00.000Z',
  },
});

describe('LinkedIn Page adapter (spec 14.5, 14.8)', () => {
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

  it('authorizationUrl: OAuth 2.0 code flow with state and capability scopes (no PKCE on LinkedIn)', async () => {
    const { url } = await adapter.authorizationUrl({
      state: 'st_1',
      codeVerifier: 'v',
      redirectUri: 'https://app.test/cb',
      client,
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(u.searchParams.get('state')).toBe('st_1');
    expect(u.searchParams.get('scope')).toBe(adapter.capability.requiredScopes.join(' '));
    expect(u.searchParams.has('code_challenge')).toBe(false);
  });

  it('exchangeCode: tokens, identity, administered organisations sorted with alternatives; missingScopes works on the grant', async () => {
    load('auth', 'exchange');
    const grant = await adapter.exchangeCode(
      { code: 'code_1', codeVerifier: 'v', redirectUri: 'https://app.test/cb', client },
      io,
    );
    expect(grant.remoteAccountId).toBe('2001');
    expect(grant.displayName).toBe('Ore Media');
    expect(grant.alternatives).toEqual([{ remoteAccountId: '2002', displayName: 'Tar Studio' }]);
    expect(grant.credentials.refreshToken).toBe('rt_1_fake');
    expect(grant.credentials.extra?.['organizationUrn']).toBe('urn:li:organization:2001');
    expect(missingScopes(adapter.capability.requiredScopes, grant.grantedScopes)).toEqual([]);
    expect(missingScopes(adapter.capability.requiredScopes, ['openid'])).toContain('w_organization_social');
    // the code exchange is effecting (the code is spent); identity and organisation reads are not
    expect(io.calls.filter((c) => c.mutation).map((c) => new URL(c.url).pathname)).toEqual([
      '/oauth/v2/accessToken',
    ]);
    expect(server.remaining()).toEqual([]);
  });

  it('refresh: rotates tokens; invalid_grant → reconnect_required; no refresh token → reconnect_required', async () => {
    load('auth', 'refresh_ok');
    const ok = await adapter.refresh(creds, client, io);
    expect(ok).toMatchObject({
      ok: true,
      credentials: { accessToken: 'at_2_fake', refreshToken: 'rt_2_fake' },
    });
    expect(io.calls.map((c) => c.mutation)).toEqual([true]); // a refresh issues new tokens: effecting
    load('auth', 'refresh_revoked');
    expect(await adapter.refresh(creds, client, io)).toEqual({ ok: false, reason: 'reconnect_required' });
    expect(await adapter.refresh({ accessToken: 'x' }, client, io)).toEqual({
      ok: false,
      reason: 'reconnect_required',
    });
  });

  it('validateVariant: capability limits plus platform rules (too long, wrong mime, too many images, mixed media, alt text)', () => {
    const img = { mime: 'image/jpeg', width: 1200, height: 627, bytes: 1000 };
    expect(adapter.validateVariant({ text: TEXT, altTexts: ['alt'], media: [img], settings: {} }).ok).toBe(
      true,
    );
    const long = adapter.validateVariant({ text: 'x'.repeat(3001), altTexts: [], media: [], settings: {} });
    expect(long.issues[0]?.issue).toMatch(/^text_too_long/);
    const bad = adapter.validateVariant({
      text: 'ok',
      altTexts: [],
      media: [
        ...Array.from({ length: 21 }, () => img),
        { mime: 'image/bmp', width: 100, height: 100, bytes: 10 },
      ],
      settings: {},
    });
    const issues = bad.issues.map((i) => i.issue);
    expect(issues.some((i) => i.startsWith('too_many_images'))).toBe(true);
    expect(issues).toContain('mime_not_supported:image/bmp');
    const mixed = adapter.validateVariant({
      text: 'ok',
      altTexts: [],
      media: [img, { mime: 'video/mp4', width: 1920, height: 1080, bytes: 10, durationMs: 1000 }],
      settings: {},
    });
    expect(mixed.issues.map((i) => i.issue)).toContain('mixed_media_not_supported');
    const alt = adapter.validateVariant({
      text: 'ok',
      altTexts: [''],
      media: [img],
      settings: { requireAltText: true },
    });
    expect(alt.issues.map((i) => i.issue)).toContain('alt_text_missing');
    expect(adapter.measureText('héllo 🚀')).toEqual({ length: 7, limit: 3000 });
  });

  it('publish (text only): creates the post and returns accepted with the x-restli-id', async () => {
    load('publish', 'text_success');
    const out = await adapter.publish(request(), creds, io);
    expect(out).toEqual({
      outcome: 'accepted',
      remotePostId: 'urn:li:share:7001',
      remoteUrl: 'https://www.linkedin.com/feed/update/urn:li:share:7001',
    });
    expect(io.calls.at(-1)).toMatchObject({ method: 'POST', mutation: true });
    expect(server.requests[0]?.headers['linkedin-version']).toBe('202601');
    expect(server.remaining()).toEqual([]);
  });

  it('publish (image): fetches bytes, registers and uploads, returns pending with the media urn', async () => {
    load('publish', 'image_pending');
    const out = await adapter.publish(request([image]), creds, io);
    expect(out.outcome).toBe('pending');
    if (out.outcome !== 'pending') return;
    expect(out.pending.remoteJobId).toBe('urn:li:image:C4D_1');
    expect(out.pending.data).toMatchObject({
      v: 1,
      media: [{ urn: 'urn:li:image:C4D_1', kind: 'image', altText: 'A launch banner' }],
    });
    expect(io.calls.map((c) => `${c.mutation ? 'M' : 'R'} ${c.method}`)).toEqual([
      'R GET',
      'M POST',
      'M PUT',
    ]);
    expect(server.remaining()).toEqual([]);
  });

  it('outcome classification table', async () => {
    const table: Array<[string, string, Record<string, unknown>]> = [
      ['rejected_validation', 'rejected', { code: 'rejected' }],
      ['rate_limited', 'retryable_error', { code: 'rate_limited', retryAfterMs: 30_000 }],
      ['expired_token', 'retryable_error', { code: 'refresh_token' }],
      ['revoked_token', 'rejected', { code: 'reconnect_required' }],
      ['server_error_after_send', 'unknown', {}],
      ['timeout_after_send', 'unknown', { code: 'transport_after_send' }],
      ['image_upload_5xx', 'retryable_error', { code: 'pre_publish_http_503' }],
    ];
    for (const [scenario, outcome, extra] of table) {
      load('publish', scenario);
      const out = await adapter.publish(request(scenario === 'image_upload_5xx' ? [image] : []), creds, io);
      expect(out.outcome, scenario).toBe(outcome);
      if (extra['code'] === 'rejected') expect((out as { code: string }).code).toMatch(/^linkedin_/);
      else expect(out, scenario).toMatchObject(extra);
    }
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    const out = await adapter.publish(request(), creds, refused);
    expect(out).toMatchObject({ outcome: 'retryable_error', code: 'transport_before_send' });
    const refusedUpload = await adapter.publish(request([image]), creds, refused);
    expect(refusedUpload).toMatchObject({ outcome: 'retryable_error', code: 'transport_before_publish' });
    expect(adapter.classifyError({ status: 429, body: '', phase: 'after_send' })).toEqual({
      kind: 'rate_limited',
      phase: 'before_send',
    });
    expect(adapter.classifyError({ status: 500, body: '', phase: 'after_send' })).toEqual({
      kind: 'unknown',
    });
    expect(adapter.classifyError({ status: 403, body: '{}', phase: 'after_send' })).toEqual({
      kind: 'reconnect_required',
    });
  });

  it('checkStatus: processing while media processes, ready when AVAILABLE, failed on PROCESSING_FAILED', async () => {
    load('pending', 'check_processing');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toMatchObject({ status: 'processing' });
    load('pending', 'check_ready');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toEqual({ status: 'ready' });
    load('pending', 'check_failed');
    expect(await adapter.checkStatus(pendingState(), creds, io)).toMatchObject({
      status: 'failed',
      code: 'media_processing_failed',
    });
    expect(io.calls.every((c) => !c.mutation)).toBe(true);
  });

  it('finalize creates the post; afterwards checkStatus reports completed, never ready again (spec 20.3)', async () => {
    load('pending', 'finalize_completed');
    const done = await adapter.finalize(pendingState(), creds, io);
    expect(done).toEqual({
      status: 'completed',
      remotePostId: 'urn:li:ugcPost:7002',
      remoteUrl: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:7002',
    });
    load('pending', 'check_after_finalize');
    for (let i = 0; i < 3; i += 1) {
      const again = await adapter.checkStatus(pendingState(), creds, io);
      expect(again).toEqual({
        status: 'completed',
        remotePostId: 'urn:li:ugcPost:7002',
        remoteUrl: 'https://www.linkedin.com/feed/update/urn:li:ugcPost:7002',
      });
    }
    expect(io.calls.every((c) => !c.mutation)).toBe(true);
  });

  it('finalize-already-completed: a duplicate rejection resolves to the existing post; ambiguous failures throw', async () => {
    load('pending', 'finalize_duplicate_then_found');
    expect(await adapter.finalize(pendingState(), creds, io)).toMatchObject({
      status: 'completed',
      remotePostId: 'urn:li:ugcPost:7002',
    });
    load('pending', 'finalize_5xx');
    await expect(adapter.finalize(pendingState(), creds, io)).rejects.toBeInstanceOf(AmbiguousMutationError);
    load('pending', 'finalize_reset_after_send');
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
      remoteAccountId: '2001',
    };
    load('reconcile', 'found');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({
      status: 'found',
      remotePostId: 'urn:li:share:7010',
      remoteUrl: 'https://www.linkedin.com/feed/update/urn:li:share:7010',
      matchedBy: 'fingerprint',
    });
    load('reconcile', 'absent');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({ status: 'definitely_absent' });
    load('reconcile', 'cannot_determine');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({
      status: 'cannot_determine',
      reason: 'scan_http_500',
    });
    const refused = await fixtureIO(server, { providerKey: adapter.key, refuse: true });
    expect(await adapter.findRemotePost(req, creds, refused)).toMatchObject({ status: 'cannot_determine' });
  });

  it('findRemotePost judges coverage by lastModifiedAt (the scan sort key), never by createdAt', async () => {
    const req = {
      publicationId: 'pub_1',
      attemptStartedAt: new Date('2026-09-24T00:00:00.000Z'),
      textFingerprint: textFingerprint(TEXT),
      mediaFingerprints: [],
      remoteAccountId: '2001',
    };
    // old posts edited after the attempt fill the first page; the attempt's post is on the second
    load('reconcile', 'edited_old_post_first');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({
      status: 'found',
      remotePostId: 'urn:li:share:7011',
      remoteUrl: 'https://www.linkedin.com/feed/update/urn:li:share:7011',
      matchedBy: 'fingerprint',
    });
    expect(io.calls.map((c) => new URL(c.url).searchParams.get('start'))).toEqual(['0', '20']);
    // a full page that reaches a post last modified before the window proves absence without another page
    load('reconcile', 'covered_by_last_modified');
    expect(await adapter.findRemotePost(req, creds, io)).toEqual({ status: 'definitely_absent' });
    expect(io.calls).toHaveLength(1);
  });

  it('fetchPostMetrics / fetchAccountMetrics: raw native points, unavailable as null rows', async () => {
    const window = { start: '2026-09-21T00:00:00.000Z', end: '2026-09-23T00:00:00.000Z' };
    load('read', 'post_metrics');
    const post = await adapter.fetchPostMetrics({ remotePostId: 'urn:li:share:7001', window }, creds, io);
    expect(post.find((p) => p.nativeName === 'impressionCount')).toMatchObject({
      value: 1234,
      completeness: 'complete',
      windowStart: window.start,
    });
    expect(post).toHaveLength(adapter.capability.analytics.post.length);
    load('read', 'account_metrics');
    const account = await adapter.fetchAccountMetrics({ remoteAccountId: '2001', window }, creds, io);
    expect(account.find((p) => p.nativeName === 'followerGains.organicFollowerGain')).toMatchObject({
      value: 10,
      completeness: 'complete',
    });
    expect(account.find((p) => p.nativeName === 'followerGains.organicFollowerGain')?.series).toHaveLength(2);
    expect(
      account.find((p) => p.nativeName === 'totalPageStatistics.views.allPageViews.pageViews'),
    ).toMatchObject({ value: null, completeness: 'unavailable' });
  });

  it('fetchComments pages by offset; comment replies as the organisation', async () => {
    load('read', 'comments_page');
    const page = await adapter.fetchComments({ remotePostId: 'urn:li:share:7001' }, creds, io);
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({
      parentRemoteId: 'urn:li:comment:(urn:li:share:7001,1)',
      text: 'Thanks',
    });
    expect(page.nextCursor).toBeUndefined();
    load('read', 'comment_reply');
    const out = await adapter.comment(
      { remotePostId: 'urn:li:share:7001', text: 'Thanks for the support', idempotencyKey: 'att_2' },
      creds,
      io,
    );
    expect(out).toEqual({
      outcome: 'accepted',
      remotePostId: 'urn:li:comment:(urn:li:share:7001,3)',
      remoteUrl: 'https://www.linkedin.com/feed/update/urn:li:share:7001',
    });
  });
});
