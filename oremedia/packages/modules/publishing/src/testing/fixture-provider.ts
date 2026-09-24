import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AccountGrant,
  DecryptedCredentials,
  PendingCheck,
  ProviderCapabilityV1,
  PublishOutcome,
  ReconcileResult,
  RefreshResult,
} from '@oremedia/contracts/providers';
import {
  ProviderTransportError,
  classifyByStatus,
  plainMeasure,
  validateVariantAgainstCapability,
  type ProviderAdapter,
  type ProviderIO,
  type PublishMedia,
  type PublishRequest,
} from '@oremedia/providers';

/**
 * Test fixture only (never registered in production): an in-memory platform whose behaviour a test scripts per
 * call. `certifiedAt` is set so the registry's certification gate lets tests through; `posts` is the remote
 * account, so a test can assert that a crash after send produced exactly one post. The post-creating call goes
 * through the real ProviderIO to a loopback endpoint (configure publishing providers with `insecureAllowLoopback`),
 * so the send boundary the runtime relies on (sentAt before the first mutation) is exercised, not simulated.
 */
export const FIXTURE_PROVIDER_KEY = 'fixture_provider';

export const fixtureCapability = (over: Partial<ProviderCapabilityV1> = {}): ProviderCapabilityV1 => ({
  key: FIXTURE_PROVIDER_KEY,
  version: 1,
  text: {
    maxLength: 280,
    weighted: false,
    supportsLinks: true,
    supportsMentions: true,
    supportsHashtags: true,
  },
  media: {
    image: {
      mimes: ['image/png', 'image/jpeg'],
      minWidth: 100,
      maxWidth: 4096,
      aspectRatios: [],
      maxBytes: 8_000_000,
      maxCount: 4,
    },
    carousel: { min: 2, max: 4 },
    altText: true,
    publicUrlFetch: { required: false, processingWindowSec: 60 },
  },
  threading: 'none',
  asyncProcessing: true,
  idempotencyKeySupported: true,
  reconciliation: 'by_recent_posts_scan',
  analytics: { post: [], account: [], latencyHours: 1 },
  comments: { read: false, reply: false },
  edit: false,
  delete: true,
  rateLimits: [],
  requiredScopes: ['w_post'],
  certifiedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

export type PublishBehaviour =
  | { kind: 'accept' }
  | { kind: 'pending' }
  | { kind: 'reject'; code?: string }
  | { kind: 'before_send_failure' }
  | { kind: 'after_send_failure' }
  /** The platform records the post, then the response is lost (crash after send). */
  | { kind: 'crash_after_send' };

export interface FixturePost {
  id: string;
  text: string;
  textFingerprint: string;
  idempotencyKey: string;
  /** What the platform received: the signed release URLs and hashes minted at dispatch (spec 9.3). */
  media: PublishMedia[];
  createdAt: Date;
  finalised: boolean;
}

let endpoint: Promise<string> | null = null;
/** One loopback HTTP endpoint per process that accepts the fixture's post-creating request (the platform is in memory). */
function fixtureEndpoint(): Promise<string> {
  return (endpoint ??= new Promise<string>((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    server.unref();
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  }));
}

export class FixtureProviderAdapter implements ProviderAdapter {
  readonly key = FIXTURE_PROVIDER_KEY;
  readonly capability: ProviderCapabilityV1;
  readonly posts: FixturePost[] = [];
  behaviour: PublishBehaviour = { kind: 'accept' };
  refreshBehaviour: RefreshResult = {
    ok: true,
    credentials: { accessToken: 'at_refreshed', refreshToken: 'rt_2' },
  };
  reconcileBehaviour: 'scan' | 'cannot_determine' = 'scan';
  pendingChecks: PendingCheck['status'][] = ['processing', 'ready'];
  grant: AccountGrant = {
    remoteAccountId: 'acct_fixture',
    displayName: 'Fixture account',
    grantedScopes: ['w_post'],
    credentials: { accessToken: 'at_fixture_secret', refreshToken: 'rt_fixture_secret' },
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  readonly calls: string[] = [];
  private seq = 0;

  constructor(over: Partial<ProviderCapabilityV1> = {}) {
    this.capability = fixtureCapability(over);
  }

  async authorizationUrl(input: { state: string; redirectUri: string }) {
    this.calls.push('authorizationUrl');
    return {
      url: `https://fixture.example/oauth?state=${input.state}&redirect_uri=${encodeURIComponent(input.redirectUri)}`,
    };
  }
  async exchangeCode(input: { code: string }): Promise<AccountGrant> {
    this.calls.push(`exchangeCode:${input.code}`);
    if (input.code === 'bad') throw new Error('invalid code');
    return this.grant;
  }
  async refresh(credentials: DecryptedCredentials): Promise<RefreshResult> {
    this.calls.push(`refresh:${credentials.refreshToken ?? ''}`);
    return this.refreshBehaviour;
  }
  validateVariant(variant: Parameters<ProviderAdapter['validateVariant']>[0]) {
    return validateVariantAgainstCapability(this.capability, variant, this.measureText.bind(this));
  }
  measureText(text: string) {
    return plainMeasure(this.capability.text.maxLength)(text);
  }
  async publish(req: PublishRequest, creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome> {
    this.calls.push(`publish:${req.attemptId}`);
    if (creds.accessToken !== this.grant.credentials.accessToken && creds.accessToken !== 'at_refreshed')
      return { outcome: 'rejected', code: 'unauthorised', message: 'bad token' };
    const b = this.behaviour;
    // A failure before the post-creating mutation left (e.g. a refused connection on a pre-boundary step).
    if (b.kind === 'before_send_failure')
      throw new ProviderTransportError(
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        'before_send',
      );
    await io.request(
      `${await fixtureEndpoint()}/posts`,
      { method: 'POST', body: JSON.stringify({ idempotencyKey: req.idempotencyKey }) },
      { mutation: true },
    );
    if (b.kind === 'reject')
      return { outcome: 'rejected', code: b.code ?? 'validation', message: 'rejected by fixture' };
    const existing = this.posts.find((p) => p.idempotencyKey === req.idempotencyKey);
    const post = existing ?? this.record(req);
    if (b.kind === 'after_send_failure')
      throw new ProviderTransportError(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        'after_send',
      );
    if (b.kind === 'crash_after_send') throw new Error('worker lost after send');
    if (b.kind === 'pending')
      return {
        outcome: 'pending',
        pending: { remoteJobId: `job_${post.id}`, data: { postId: post.id } },
        remoteJobId: `job_${post.id}`,
      };
    return { outcome: 'accepted', remotePostId: post.id, remoteUrl: `https://fixture.example/p/${post.id}` };
  }
  async checkStatus(pending: { data: Record<string, unknown> }): Promise<PendingCheck> {
    this.calls.push('checkStatus');
    const post = this.posts.find((p) => p.id === pending.data['postId']);
    if (!post) return { status: 'failed', code: 'not_found', message: 'no such job' };
    if (post.finalised)
      return {
        status: 'completed',
        remotePostId: post.id,
        remoteUrl: `https://fixture.example/p/${post.id}`,
      };
    const next = this.pendingChecks.shift() ?? 'ready';
    return next === 'ready' ? { status: 'ready' } : { status: 'processing', retryAfterMs: 10 };
  }
  async finalize(pending: { data: Record<string, unknown> }): Promise<PendingCheck> {
    this.calls.push('finalize');
    const post = this.posts.find((p) => p.id === pending.data['postId']);
    if (!post) return { status: 'failed', code: 'not_found', message: 'no such job' };
    post.finalised = true; // spec 20.3: once finalised, checkStatus must report completed
    return { status: 'completed', remotePostId: post.id, remoteUrl: `https://fixture.example/p/${post.id}` };
  }
  async findRemotePost(req: { textFingerprint: string; attemptStartedAt: Date }): Promise<ReconcileResult> {
    this.calls.push('findRemotePost');
    if (this.reconcileBehaviour === 'cannot_determine')
      return { status: 'cannot_determine', reason: 'fixture' };
    const found = this.posts.find(
      (p) =>
        p.textFingerprint === req.textFingerprint &&
        p.createdAt >= new Date(req.attemptStartedAt.getTime() - 1000),
    );
    return found
      ? {
          status: 'found',
          remotePostId: found.id,
          remoteUrl: `https://fixture.example/p/${found.id}`,
          matchedBy: 'fingerprint',
        }
      : { status: 'definitely_absent' };
  }
  classifyError(input: Parameters<ProviderAdapter['classifyError']>[0]) {
    return classifyByStatus(input);
  }

  private record(req: PublishRequest): FixturePost {
    const post: FixturePost = {
      id: `post_${++this.seq}`,
      text: req.text,
      textFingerprint: req.textFingerprint,
      idempotencyKey: req.idempotencyKey,
      media: req.media.map((m) => ({ ...m })),
      createdAt: new Date(),
      finalised: false,
    };
    this.posts.push(post);
    return post;
  }
}
