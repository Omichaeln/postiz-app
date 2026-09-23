import { z } from 'zod';

export const PublicationState = z.enum([
  'scheduled',
  'dispatching',
  'processing',
  'published',
  'failed',
  'outcome_unknown',
  'retry_eligible',
  'cancelled',
  'held',
]);
export type PublicationState = z.infer<typeof PublicationState>;

export const PublicationAuthority = z.enum(['approval', 'mandate']);
export type PublicationAuthority = z.infer<typeof PublicationAuthority>;

export const AttemptOutcome = z.enum(['accepted', 'pending', 'rejected', 'retryable_error', 'unknown']);
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;

/** Spec 14.1: the scheduling command. */
export const ScheduleCommand = z.object({
  channelVariantId: z.string(),
  scheduledFor: z.string().datetime(),
  authority: PublicationAuthority,
  approvalId: z.string().optional(),
  mandateId: z.string().optional(),
  occurrence: z.string().max(40).optional(), // deliberate repeats get a new occurrence value
});
export type ScheduleCommand = z.infer<typeof ScheduleCommand>;

export const CancelCommand = z.object({ publicationId: z.string(), expectedVersion: z.number().int() });
export const RescheduleCommand = z.object({
  publicationId: z.string(),
  expectedVersion: z.number().int(),
  scheduledFor: z.string().datetime(),
});
export const ReconcileCommand = z.object({
  publicationId: z.string(),
  resolution: z.enum(['confirm_published', 'confirm_absent', 'cancel']),
  remotePostId: z.string().optional(),
  remoteUrl: z.string().optional(),
  note: z.string().max(500).optional(),
});

export interface AttemptResult {
  attemptId: string;
  outcome: AttemptOutcome;
  remotePostId?: string;
  remoteUrl?: string;
  remoteJobId?: string;
  pending?: unknown;
  errorCode?: string;
  errorDetail?: string;
  retryAfterMs?: number;
  error?: string;
}

export const ChannelConnectStart = z.object({
  brandId: z.string(),
  providerKey: z.string(),
  redirectUri: z.string().url(),
});
export const ChannelConnectComplete = z.object({ state: z.string(), code: z.string() });

export const MandateSourceRules = z.object({
  onlyApprovedFacts: z.boolean().default(true),
  onlyApprovedTemplates: z.boolean().default(true),
  onlyApprovedAssets: z.boolean().default(true),
  requireBrandReviewClean: z.boolean().default(true),
});
export type MandateSourceRules = z.infer<typeof MandateSourceRules>;

export const MandateState = z.enum(['active', 'paused', 'revoked', 'expired']);
export const MandateCreate = z.object({
  brandId: z.string(),
  servicePrincipalId: z.string(),
  channelConnectionIds: z.array(z.string()).min(1).max(50),
  allowedContentClasses: z.array(z.string()).min(1).max(50),
  sourceRules: MandateSourceRules,
  maxPostsPerDay: z.number().int().min(1).max(100),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(), // mandates always expire
});
