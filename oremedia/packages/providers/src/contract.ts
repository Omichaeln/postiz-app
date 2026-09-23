import type {
  AccountGrant,
  ChannelVariantInput,
  ClientConfig,
  CommentPage,
  DecryptedCredentials,
  MetricWindow,
  PendingCheck,
  PendingState,
  ProviderCapabilityV1,
  ProviderErrorClass,
  PublishOutcome,
  RawMetricPoint,
  ReconcileResult,
  RefreshResult,
  ValidationResult,
} from '@oremedia/contracts/providers';
import type { ProviderIO } from './io';

export interface PublishMedia {
  /** Signed release URL minted at dispatch (spec 9.3) or bytes for providers that accept uploads. */
  url: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  altText?: string;
  contentHash: string;
}

export interface PublishRequest {
  publicationId: string;
  attemptId: string;
  /** providerIdempotencyKey = attempt id whenever the platform supports it (spec 14.3). */
  idempotencyKey: string;
  remoteAccountId: string;
  text: string;
  media: PublishMedia[];
  settings: Record<string, unknown>;
  /** Fingerprints recorded on the attempt so reconciliation can match a remote post. */
  textFingerprint: string;
  mediaFingerprints: string[];
}

export interface CommentRequest {
  remotePostId: string;
  text: string;
  idempotencyKey: string;
}

/**
 * Spec 14.5: the provider adapter contract. Credentials are passed in explicitly (never a DB row); outcomes are
 * classified; reconciliation is first-class; all network I/O goes through ProviderIO.
 */
export interface ProviderAdapter {
  readonly key: string; // 'linkedin_page', 'instagram_business', ...
  readonly capability: ProviderCapabilityV1; // versioned; see 14.6

  // Auth
  authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    client: ClientConfig;
  }): Promise<{ url: string }>;
  exchangeCode(
    input: { code: string; codeVerifier: string; redirectUri: string; client: ClientConfig },
    io: ProviderIO,
  ): Promise<AccountGrant>;
  refresh(credentials: DecryptedCredentials, client: ClientConfig, io: ProviderIO): Promise<RefreshResult>;

  // Validation: pure, capability-driven, no network
  validateVariant(variant: ChannelVariantInput): ValidationResult;
  measureText(text: string): { length: number; limit: number };

  // Publishing
  publish(req: PublishRequest, creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome>;
  checkStatus?(pending: PendingState, creds: DecryptedCredentials, io: ProviderIO): Promise<PendingCheck>; // read-only
  finalize?(pending: PendingState, creds: DecryptedCredentials, io: ProviderIO): Promise<PendingCheck>; // once done, checkStatus must return 'completed'
  comment?(req: CommentRequest, creds: DecryptedCredentials, io: ProviderIO): Promise<PublishOutcome>;

  // Reconciliation
  findRemotePost(
    req: {
      publicationId: string;
      attemptStartedAt: Date;
      textFingerprint: string;
      mediaFingerprints: string[];
      remoteAccountId: string;
    },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<ReconcileResult>;

  // Measurement and community
  fetchPostMetrics?(
    req: { remotePostId: string; window: MetricWindow },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<RawMetricPoint[]>;
  fetchAccountMetrics?(
    req: { remoteAccountId: string; window: MetricWindow },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<RawMetricPoint[]>;
  fetchComments?(
    req: { remotePostId: string; since?: Date; cursor?: string },
    creds: DecryptedCredentials,
    io: ProviderIO,
  ): Promise<CommentPage>;

  // Error classification (adds pre/post-effect)
  classifyError(input: {
    status?: number;
    body?: string;
    phase: 'before_send' | 'after_send';
    error?: unknown;
  }): ProviderErrorClass;
}
