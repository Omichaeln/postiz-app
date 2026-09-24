import { z } from 'zod';
import { TenantContextInput } from './tenancy';

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
  'creative.preview_render',
]);
export type FeatureFlagKey = z.infer<typeof FeatureFlagKey>;

export const KillSwitchScope = z.enum(['agent_starts', 'release_dispatch']);
export type KillSwitchScope = z.infer<typeof KillSwitchScope>;

/** Runbook "drain and replay the outbox": replay one dead-lettered event of the caller's tenant. */
export const OutboxReplay = z.object({ eventId: z.string() });
export type OutboxReplay = z.infer<typeof OutboxReplay>;

/**
 * Spec 17.5 deletion fan-out: deletionRequestWorkflowV1 on task queue `core`, started from the outbox event
 * `operations.deletion_requested`. Each registered subsystem handler runs as its own activity and records its
 * completion (fanout status + audited evidence) on the deletion request; a repeat of a finished handler is a no-op.
 */
export const DeletionWorkflowInputV1 = TenantContextInput.extend({ deletionRequestId: z.string() });
export type DeletionWorkflowInputV1 = z.infer<typeof DeletionWorkflowInputV1>;

export const DeletionFanoutStatus = z.enum(['pending', 'done', 'blocked', 'not_applicable']);
export type DeletionFanoutStatus = z.infer<typeof DeletionFanoutStatus>;

export interface DeletionPlanV1 {
  state: z.infer<typeof DeletionRequestState>;
  /** Handlers (in run order) whose fan-out entry is still pending. */
  pending: string[];
}

export interface DeletionStepResultV1 {
  handler: string;
  status: 'done' | 'not_applicable' | 'operator_action_required' | 'skipped';
  /** Per-table or per-store counts, e.g. { publications: 3, objects: 2 }. */
  evidence: Record<string, number | string>;
}

export interface DeletionFinishResultV1 {
  state: z.infer<typeof DeletionRequestState>;
  /** Fan-out entries a person must complete (Temporal visibility, logs, backups: see the deletion runbook). */
  operatorActions: string[];
}

export interface DeletionActivitiesV1 {
  beginDeletion(input: DeletionWorkflowInputV1): Promise<DeletionPlanV1>;
  runDeletionHandler(input: DeletionWorkflowInputV1 & { handler: string }): Promise<DeletionStepResultV1>;
  finishDeletion(input: DeletionWorkflowInputV1): Promise<DeletionFinishResultV1>;
}

/** Spec 17.5 TTL job: retentionSweepWorkflowV1 on task queue `core`, started by a Temporal schedule. */
export const RetentionSweepArgsV1 = z.object({
  dryRun: z.boolean().optional(),
  now: z.string().datetime().optional(),
  correlationId: z.string().optional(),
});
export type RetentionSweepArgsV1 = z.infer<typeof RetentionSweepArgsV1>;

export interface RetentionSweepInputV1 {
  correlationId: string;
  now: string;
  dryRun: boolean;
}

export interface RetentionClassResultV1 {
  dataClass: z.infer<typeof RetentionDataClass>;
  handler: string;
  retentionDays: number;
  cutoff: string;
  /** Rows removed, or rows that would be removed in a dry run. */
  rows: number;
}

export interface RetentionTenantResultV1 {
  tenantId: string;
  dryRun: boolean;
  classes: RetentionClassResultV1[];
}

export interface RetentionActivitiesV1 {
  listRetentionTenants(input: RetentionSweepInputV1): Promise<string[]>;
  applyRetention(input: RetentionSweepInputV1 & { tenantId: string }): Promise<RetentionTenantResultV1>;
}

/** The module-side implementations the activities wrap (tenant context is established by the activity host). */
export type DeletionRuntimeV1 = DeletionActivitiesV1;
export type RetentionRuntimeV1 = RetentionActivitiesV1;
