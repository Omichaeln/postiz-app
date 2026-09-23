import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { createdAt, hash, id, ref, tenantId, ts, updatedAt, version } from './_columns';

export const outboxEvents = mysqlTable(
  'outbox_events',
  {
    id: id(),
    tenantId: tenantId(),
    aggregateType: varchar('aggregate_type', { length: 60 }).notNull(),
    aggregateId: ref('aggregate_id').notNull(),
    aggregateVersion: int('aggregate_version').notNull(),
    eventType: varchar('event_type', { length: 80 }).notNull(),
    schemaVersion: int('schema_version').notNull(),
    payload: json('payload').$type<Record<string, unknown>>().notNull(), // references only, never secrets or media
    correlationId: varchar('correlation_id', { length: 64 }).notNull(),
    availableAt: ts('available_at').notNull(),
    claimedBy: varchar('claimed_by', { length: 80 }),
    claimExpiresAt: ts('claim_expires_at'),
    dispatchedAt: ts('dispatched_at'),
    attempts: int('attempts').notNull().default(0),
    lastError: varchar('last_error', { length: 1000 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_outbox_ready').on(t.dispatchedAt, t.availableAt),
    index('ix_outbox_claim').on(t.claimedBy, t.dispatchedAt),
  ],
);

export const idempotencyKeys = mysqlTable(
  'idempotency_keys',
  {
    tenantId: tenantId(),
    principalId: ref('principal_id').notNull(),
    key: varchar('key', { length: 120 }).notNull(),
    requestHash: hash('request_hash').notNull(),
    path: varchar('path', { length: 120 }).notNull(),
    responseStatus: int('response_status'),
    responseBody: json('response_body'),
    state: mysqlEnum('state', ['in_progress', 'completed']).notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.principalId, t.key] }),
    index('ix_idempotency_expiry').on(t.expiresAt),
  ],
);

/** Insert-only. */
export const auditEvents = mysqlTable(
  'audit_events',
  {
    id: id(),
    tenantId: tenantId(),
    actorKind: varchar('actor_kind', { length: 24 }).notNull(),
    actorId: ref('actor_id').notNull(),
    supportSessionId: ref('support_session_id'),
    action: varchar('action', { length: 80 }).notNull(),
    resourceType: varchar('resource_type', { length: 60 }).notNull(),
    resourceId: ref('resource_id').notNull(),
    decision: mysqlEnum('decision', ['allowed', 'denied']).notNull(),
    reason: varchar('reason', { length: 120 }),
    correlationId: varchar('correlation_id', { length: 64 }).notNull(),
    metadata: json('metadata').$type<Record<string, unknown>>(), // allowlisted fields only
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_audit_resource').on(t.tenantId, t.resourceType, t.resourceId),
    index('ix_audit_actor').on(t.tenantId, t.actorId, t.createdAt),
  ],
);

export const deletionRequests = mysqlTable(
  'deletion_requests',
  {
    id: id(),
    tenantId: tenantId(),
    subjectType: mysqlEnum('subject_type', [
      'user',
      'asset',
      'brand',
      'tenant',
      'channel_connection',
      'customer_voice',
    ]).notNull(),
    subjectId: ref('subject_id').notNull(),
    reason: varchar('reason', { length: 500 }).notNull(),
    requestedByKind: varchar('requested_by_kind', { length: 24 }).notNull(),
    requestedById: ref('requested_by_id').notNull(),
    state: mysqlEnum('state', ['requested', 'in_progress', 'completed', 'blocked'])
      .notNull()
      .default('requested'),
    fanout: json('fanout')
      .$type<Record<string, 'pending' | 'done' | 'blocked' | 'not_applicable'>>()
      .notNull(),
    blockedReason: varchar('blocked_reason', { length: 500 }),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index('ix_deletion_state').on(t.state, t.createdAt)],
);

export const retentionPolicies = mysqlTable(
  'retention_policies',
  {
    id: id(),
    tenantId: tenantId(),
    dataClass: mysqlEnum('data_class', [
      'user_identity',
      'asset_files',
      'creative_revisions',
      'agent_transcripts',
      'audit_and_evidence',
      'social_tokens',
      'metrics',
      'customer_voice_raw',
    ]).notNull(),
    retentionDays: int('retention_days'),
    basis: varchar('basis', { length: 40 }).notNull(), // 'default' | 'contract'
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('uq_retention_class').on(t.tenantId, t.dataClass)],
);

export const incidents = mysqlTable(
  'incidents',
  {
    id: id(),
    tenantId: tenantId(),
    severity: mysqlEnum('severity', ['sev1', 'sev2', 'sev3', 'sev4']).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    summary: text('summary').notNull(),
    state: mysqlEnum('state', ['open', 'mitigated', 'resolved', 'postmortem_done']).notNull().default('open'),
    openedByUserId: ref('opened_by_user_id').notNull(),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [index('ix_incident_state').on(t.tenantId, t.state)],
);

/** Global engineering flags (spec 22.1): owner, removal date, targeting, success metric. Listed in GLOBAL_TABLES. */
export const featureFlags = mysqlTable('feature_flags', {
  key: varchar('key', { length: 80 }).primaryKey(),
  enabledDefault: boolean('enabled_default').notNull().default(false),
  targeting: json('targeting').$type<{ tenantIds?: string[]; percentage?: number }>().notNull(),
  owner: varchar('owner', { length: 120 }).notNull(),
  removalDate: ts('removal_date').notNull(),
  successMetric: varchar('success_metric', { length: 200 }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

/** Tenant/brand kill switches for autonomous publication and agent starts (spec 13.4, 23.3). brand_id '' = tenant-wide. */
export const killSwitches = mysqlTable(
  'kill_switches',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: varchar('brand_id', { length: 32 }).notNull().default(''),
    scope: mysqlEnum('scope', ['agent_starts', 'release_dispatch']).notNull(),
    engaged: boolean('engaged').notNull().default(false),
    reason: varchar('reason', { length: 500 }),
    engagedByUserId: ref('engaged_by_user_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('uq_kill_switch').on(t.tenantId, t.brandId, t.scope)],
);

/** Migration mapping from external systems (spec 23.1): preserves source IDs without using them as primary keys. */
export const externalRefs = mysqlTable(
  'external_refs',
  {
    id: id(),
    tenantId: tenantId(),
    sourceSystem: varchar('source_system', { length: 40 }).notNull(),
    sourceType: varchar('source_type', { length: 60 }).notNull(),
    sourceId: varchar('source_id', { length: 200 }).notNull(),
    targetType: varchar('target_type', { length: 60 }).notNull(),
    targetId: ref('target_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_external_ref').on(t.tenantId, t.sourceSystem, t.sourceType, t.sourceId)],
);
