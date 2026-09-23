import {
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { ApprovalBindingV1 } from '@oremedia/contracts/approval';
import type { MandateSourceRules } from '@oremedia/contracts/publishing';
import type { FrozenManifestV1 } from '@oremedia/contracts/review';
import { brandId, createdAt, hash, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';
import { contentRevisions } from './content';

export const reviewRequests = mysqlTable(
  'review_requests',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    contentRevisionId: ref('content_revision_id').notNull(),
    frozenManifest: json('frozen_manifest').$type<FrozenManifestV1>().notNull(),
    manifestHash: hash('manifest_hash').notNull(),
    assignees: json('assignees').$type<string[]>().notNull(),
    dueAt: ts('due_at'),
    state: mysqlEnum('state', ['open', 'stale', 'decided', 'cancelled']).notNull().default('open'),
    staleReason: varchar('stale_reason', { length: 200 }),
    requestedByKind: mysqlEnum('requested_by_kind', ['user', 'agent']).notNull(),
    requestedById: ref('requested_by_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_review_request_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_review_request_revision').on(t.tenantId, t.contentRevisionId, t.state),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.contentRevisionId],
      foreignColumns: [contentRevisions.tenantId, contentRevisions.brandId, contentRevisions.id],
      name: 'fk_review_request_revision',
    }),
  ],
);

/** Insert-only. */
export const reviewDecisions = mysqlTable(
  'review_decisions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    reviewRequestId: ref('review_request_id').notNull(),
    deciderKind: mysqlEnum('decider_kind', ['user', 'external_reviewer']).notNull(),
    deciderId: ref('decider_id').notNull(),
    decision: mysqlEnum('decision', ['approve', 'request_changes', 'reject']).notNull(),
    comment: text('comment'),
    manifestHash: hash('manifest_hash').notNull(),
    verifiedEmail: varchar('verified_email', { length: 320 }),
    ipHash: varchar('ip_hash', { length: 64 }),
    userAgentHash: varchar('user_agent_hash', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_review_decision_request').on(t.tenantId, t.reviewRequestId),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.reviewRequestId],
      foreignColumns: [reviewRequests.tenantId, reviewRequests.brandId, reviewRequests.id],
      name: 'fk_review_decision_request',
    }),
  ],
);

export const releaseApprovals = mysqlTable(
  'release_approvals',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    contentRevisionId: ref('content_revision_id').notNull(),
    reviewRequestId: ref('review_request_id').notNull(),
    approverKind: mysqlEnum('approver_kind', ['user', 'external_reviewer']).notNull(),
    approverId: ref('approver_id').notNull(),
    bindingHash: hash('binding_hash').notNull(), // see spec 13.2
    binding: json('binding').$type<ApprovalBindingV1>().notNull(),
    validUntil: ts('valid_until'),
    state: mysqlEnum('state', ['valid', 'invalidated', 'consumed', 'expired']).notNull(),
    invalidatedReason: varchar('invalidated_reason', { length: 80 }),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_approval_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_approval_revision').on(t.tenantId, t.contentRevisionId, t.state),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.contentRevisionId],
      foreignColumns: [contentRevisions.tenantId, contentRevisions.brandId, contentRevisions.id],
      name: 'fk_approval_revision',
    }),
  ],
);

export const publishingMandates = mysqlTable(
  'publishing_mandates',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    ownerUserId: ref('owner_user_id').notNull(),
    servicePrincipalId: ref('service_principal_id').notNull(),
    channelConnectionIds: json('channel_connection_ids').$type<string[]>().notNull(),
    allowedContentClasses: json('allowed_content_classes').$type<string[]>().notNull(),
    sourceRules: json('source_rules').$type<MandateSourceRules>().notNull(), // e.g. only approved facts, only approved templates
    maxPostsPerDay: int('max_posts_per_day').notNull(),
    windowStart: ts('window_start').notNull(),
    windowEnd: ts('window_end').notNull(), // mandates always expire
    state: mysqlEnum('state', ['active', 'paused', 'revoked', 'expired']).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_mandate_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_mandate_brand',
    }),
  ],
);
