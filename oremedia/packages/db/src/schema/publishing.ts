import {
  boolean,
  char,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varbinary,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import { brandId, createdAt, hash, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

export const credentialRefs = mysqlTable(
  'credential_refs',
  {
    id: id(),
    tenantId: tenantId(),
    kmsKeyId: varchar('kms_key_id', { length: 200 }).notNull(),
    wrappedDataKey: varbinary('wrapped_data_key', { length: 512 }).notNull(),
    ciphertext: varbinary('ciphertext', { length: 8192 }).notNull(), // AES-256-GCM of { accessToken, refreshToken, extra }
    iv: varbinary('iv', { length: 12 }).notNull(),
    authTag: varbinary('auth_tag', { length: 16 }).notNull(),
    aad: varchar('aad', { length: 200 }).notNull(), // `${tenantId}:${channelConnectionId}` binds ciphertext to its owner
    rotatedAt: ts('rotated_at'),
    destroyedAt: ts('destroyed_at'),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [uniqueIndex('uq_credential_ref_ti').on(t.tenantId, t.id)],
);

export const channelConnections = mysqlTable(
  'channel_connections',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    providerKey: varchar('provider_key', { length: 40 }).notNull(),
    remoteAccountId: varchar('remote_account_id', { length: 200 }).notNull(),
    displayName: varchar('display_name', { length: 200 }).notNull(),
    credentialRefId: ref('credential_ref_id').notNull(),
    grantedScopes: json('granted_scopes').$type<string[]>().notNull(),
    missingScopes: json('missing_scopes').$type<string[]>().notNull().default([]),
    status: mysqlEnum('status', ['active', 'refresh_needed', 'reconnect_needed', 'disabled']).notNull(),
    tokenExpiresAt: ts('token_expires_at'),
    capabilityVersion: int('capability_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_channel_remote').on(t.tenantId, t.providerKey, t.remoteAccountId),
    uniqueIndex('uq_channel_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_channel_brand',
    }),
    foreignKey({
      columns: [t.tenantId, t.credentialRefId],
      foreignColumns: [credentialRefs.tenantId, credentialRefs.id],
      name: 'fk_channel_credential',
    }),
  ],
);

export const publications = mysqlTable(
  'publications',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    contentPackageId: ref('content_package_id').notNull(),
    contentRevisionId: ref('content_revision_id').notNull(),
    channelVariantId: ref('channel_variant_id').notNull(),
    channelConnectionId: ref('channel_connection_id').notNull(),
    occurrenceKey: varchar('occurrence_key', { length: 120 }).notNull(), // stable dedupe identity
    authority: mysqlEnum('authority', ['approval', 'mandate']).notNull(),
    approvalId: ref('approval_id'),
    mandateId: ref('mandate_id'),
    scheduledFor: ts('scheduled_for').notNull(),
    state: mysqlEnum('state', [
      'scheduled',
      'dispatching',
      'processing',
      'published',
      'failed',
      'outcome_unknown',
      'retry_eligible',
      'cancelled',
      'held',
    ]).notNull(),
    stateReason: varchar('state_reason', { length: 120 }),
    holdReasons: json('hold_reasons').$type<string[]>(),
    remotePostId: varchar('remote_post_id', { length: 200 }),
    remoteUrl: varchar('remote_url', { length: 1000 }),
    fencingToken: int('fencing_token').notNull().default(0),
    claimant: varchar('claimant', { length: 160 }),
    claimedAt: ts('claimed_at'),
    scheduledByKind: mysqlEnum('scheduled_by_kind', ['user', 'service_principal']).notNull(),
    scheduledById: ref('scheduled_by_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_publication_occurrence').on(t.tenantId, t.occurrenceKey),
    uniqueIndex('uq_publication_tbi').on(t.tenantId, t.brandId, t.id),
    uniqueIndex('uq_publication_ti').on(t.tenantId, t.id),
    index('ix_publication_due').on(t.state, t.scheduledFor),
    index('ix_publication_brand_state').on(t.tenantId, t.brandId, t.state, t.scheduledFor),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_publication_brand',
    }),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.channelConnectionId],
      foreignColumns: [channelConnections.tenantId, channelConnections.brandId, channelConnections.id],
      name: 'fk_publication_channel',
    }),
  ],
);

/** Insert-only apart from outcome fields written once by the attempt owner (fencing token checked). */
export const publicationAttempts = mysqlTable(
  'publication_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    publicationId: ref('publication_id').notNull(),
    attemptNumber: int('attempt_number').notNull(),
    fencingToken: int('fencing_token').notNull(),
    requestFingerprint: char('request_fingerprint', { length: 64 }).notNull(),
    providerIdempotencyKey: varchar('provider_idempotency_key', { length: 120 }),
    startedAt: ts('started_at').notNull(),
    sentAt: ts('sent_at'), // committed immediately before the outbound mutation
    finishedAt: ts('finished_at'),
    outcome: mysqlEnum('outcome', [
      'accepted',
      'pending',
      'rejected',
      'retryable_error',
      'unknown',
    ]).notNull(),
    errorCode: varchar('error_code', { length: 80 }),
    errorDetail: varchar('error_detail', { length: 2000 }), // truncated, redacted
    remoteJobId: varchar('remote_job_id', { length: 200 }),
    remotePostId: varchar('remote_post_id', { length: 200 }),
    pendingState: json('pending_state').$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('uq_attempt_fence').on(t.tenantId, t.publicationId, t.fencingToken),
    index('ix_attempt_publication').on(t.tenantId, t.publicationId, t.attemptNumber),
    foreignKey({
      columns: [t.tenantId, t.publicationId],
      foreignColumns: [publications.tenantId, publications.id],
      name: 'fk_attempt_publication',
    }),
  ],
);

/** Insert-only. */
export const remoteEvidence = mysqlTable(
  'remote_evidence',
  {
    id: id(),
    tenantId: tenantId(),
    publicationId: ref('publication_id').notNull(),
    attemptId: ref('attempt_id'),
    kind: mysqlEnum('kind', [
      'accepted_response',
      'status_poll',
      'reconciliation',
      'human_confirmation',
      'metrics_readback',
    ]).notNull(),
    remotePostId: varchar('remote_post_id', { length: 200 }),
    remoteUrl: varchar('remote_url', { length: 1000 }),
    payload: json('payload').$type<Record<string, unknown>>().notNull(), // redacted, allowlisted fields
    payloadHash: hash('payload_hash').notNull(),
    capturedAt: ts('captured_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_remote_evidence_publication').on(t.tenantId, t.publicationId, t.capturedAt)],
);

/** Global register (spec 14.6). Listed in GLOBAL_TABLES. */
export const providerCapabilities = mysqlTable(
  'provider_capabilities',
  {
    key: varchar('key', { length: 40 }).notNull(),
    version: int('version').notNull(),
    capability: json('capability').$type<ProviderCapabilityV1>().notNull(),
    certifiedAt: ts('certified_at'),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('uq_provider_capability').on(t.key, t.version)],
);
