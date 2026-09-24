import { z } from 'zod';

/** Spec 14.6: versioned capability register read by the UI, the adaptation skill and validateVariant. */
export const ProviderCapabilityV1 = z.object({
  key: z.string(),
  version: z.number().int(),
  text: z.object({
    maxLength: z.number(),
    weighted: z.boolean(),
    supportsLinks: z.boolean(),
    supportsMentions: z.boolean(),
    supportsHashtags: z.boolean(),
  }),
  media: z.object({
    image: z
      .object({
        mimes: z.array(z.string()),
        minWidth: z.number(),
        maxWidth: z.number(),
        aspectRatios: z.array(z.object({ min: z.number(), max: z.number() })),
        maxBytes: z.number(),
        maxCount: z.number(),
      })
      .optional(),
    video: z
      .object({ mimes: z.array(z.string()), maxDurationSec: z.number(), maxBytes: z.number() })
      .optional(),
    carousel: z.object({ min: z.number(), max: z.number() }).optional(),
    altText: z.boolean(),
    publicUrlFetch: z.object({ required: z.boolean(), processingWindowSec: z.number() }),
  }),
  threading: z.enum(['none', 'comments', 'thread']),
  asyncProcessing: z.boolean(),
  idempotencyKeySupported: z.boolean(),
  reconciliation: z.enum(['by_id_lookup', 'by_recent_posts_scan', 'none']),
  analytics: z.object({ post: z.array(z.string()), account: z.array(z.string()), latencyHours: z.number() }),
  comments: z.object({ read: z.boolean(), reply: z.boolean() }),
  edit: z.boolean(),
  delete: z.boolean(),
  rateLimits: z.array(
    z.object({ scope: z.enum(['app', 'account', 'tenant']), limit: z.number(), windowSec: z.number() }),
  ),
  requiredScopes: z.array(z.string()),
  certifiedAt: z.string().datetime().nullable(), // null = not certified; cannot be enabled for tenants
});
export type ProviderCapabilityV1 = z.infer<typeof ProviderCapabilityV1>;

export type PublishOutcome =
  | { outcome: 'accepted'; remotePostId: string; remoteUrl: string }
  | { outcome: 'pending'; pending: PendingState; remoteJobId?: string }
  | { outcome: 'rejected'; code: string; message: string }
  | { outcome: 'retryable_error'; code: string; message: string; retryAfterMs?: number } // only when phase === 'before_send' or platform guarantees no effect
  | { outcome: 'unknown'; code: string; message: string };

export type ProviderErrorClass =
  | { kind: 'refresh_token' }
  | { kind: 'reconnect_required' }
  | { kind: 'rate_limited'; retryAfterMs?: number; phase: 'before_send' }
  | { kind: 'rejected'; code: string }
  | { kind: 'unknown' };

export const PendingState = z.object({
  remoteJobId: z.string().optional(),
  containerId: z.string().optional(),
  data: z.record(z.unknown()).default({}),
});
export type PendingState = z.infer<typeof PendingState>;

export type PendingCheck =
  | { status: 'completed'; remotePostId: string; remoteUrl: string }
  | { status: 'ready' } // ready to finalise; once finalised, checkStatus must report 'completed'
  | { status: 'processing'; retryAfterMs?: number }
  | { status: 'failed'; code: string; message: string };

export type ReconcileResult =
  | { status: 'found'; remotePostId: string; remoteUrl: string; matchedBy: 'id' | 'fingerprint' }
  | { status: 'definitely_absent' }
  | { status: 'cannot_determine'; reason: string };

export const ChannelVariantInput = z.object({
  text: z.string(),
  altTexts: z.array(z.string()),
  media: z.array(
    z.object({
      mime: z.string(),
      width: z.number().int(),
      height: z.number().int(),
      bytes: z.number().int(),
      durationMs: z.number().int().optional(),
    }),
  ),
  settings: z.record(z.unknown()),
});
export type ChannelVariantInput = z.infer<typeof ChannelVariantInput>;

export const ValidationIssue = z.object({ path: z.string().optional(), issue: z.string() });
export const ValidationResult = z.object({ ok: z.boolean(), issues: z.array(ValidationIssue) });
export type ValidationResult = z.infer<typeof ValidationResult>;

export interface ClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface DecryptedCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  extra?: Record<string, string>;
}

export interface AccountGrant {
  remoteAccountId: string;
  displayName: string;
  grantedScopes: string[];
  credentials: DecryptedCredentials;
  tokenExpiresAt?: string;
  /** Other accounts (pages, organisations) the same grant can address; names only, never tokens. */
  alternatives?: Array<{ remoteAccountId: string; displayName: string }>;
}

export type RefreshResult =
  | { ok: true; credentials: DecryptedCredentials; tokenExpiresAt?: string }
  | { ok: false; reason: 'reconnect_required' | 'transient' };

export interface MetricWindow {
  start: string;
  end: string;
}

export interface RawMetricPoint {
  nativeName: string;
  value: number | null;
  unit?: string;
  windowStart: string;
  windowEnd: string;
  completeness: 'complete' | 'partial' | 'unavailable';
  series?: Array<{ at: string; value: number }>;
}

export interface CommentPage {
  items: Array<{
    remoteCommentId: string;
    authorHandle: string;
    text: string;
    createdAt: string;
    parentRemoteId?: string;
  }>;
  nextCursor?: string;
}

export const ChannelConnectionStatus = z.enum(['active', 'refresh_needed', 'reconnect_needed', 'disabled']);
export type ChannelConnectionStatus = z.infer<typeof ChannelConnectionStatus>;
