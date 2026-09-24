import { z } from 'zod';

export const AuditDecision = z.enum(['allowed', 'denied']);

export const AuditQuery = z.object({
  resourceType: z.string().max(60).optional(),
  resourceId: z.string().optional(),
  actorId: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export const DeletionRequestCreate = z.object({
  subjectType: z.enum(['user', 'asset', 'brand', 'tenant', 'channel_connection', 'customer_voice']),
  subjectId: z.string(),
  reason: z.string().max(500),
});
export const DeletionRequestState = z.enum(['requested', 'in_progress', 'completed', 'blocked']);

export const RetentionDataClass = z.enum([
  'user_identity',
  'asset_files',
  'creative_revisions',
  'agent_transcripts',
  'audit_and_evidence',
  'social_tokens',
  'metrics',
  'customer_voice_raw',
]);

export const IncidentSeverity = z.enum(['sev1', 'sev2', 'sev3', 'sev4']);

/** Spec 22.1: engineering flags (short-lived, server-enforced). */
export const FeatureFlagKey = z.enum([
  'studio.agent_proposals',
  'publishing.channel.linkedin_page',
  'publishing.channel.instagram_business',
  'publishing.channel.facebook_page',
  'publishing.channel.x',
  'publishing.channel.tiktok',
  'mandates.managed_autopublish',
  'intelligence.brand_analyst',
  'experiments.randomised',
]);
export type FeatureFlagKey = z.infer<typeof FeatureFlagKey>;

export const KillSwitchScope = z.enum(['agent_starts', 'release_dispatch']);
export type KillSwitchScope = z.infer<typeof KillSwitchScope>;

/** Runbook "drain and replay the outbox": replay one dead-lettered event of the caller's tenant. */
export const OutboxReplay = z.object({ eventId: z.string() });
export type OutboxReplay = z.infer<typeof OutboxReplay>;
