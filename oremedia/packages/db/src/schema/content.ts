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
import type { CopyDocumentV1, CreativeAttributesV1 } from '@oremedia/contracts/content';
import { brandId, createdAt, hash, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

export const campaigns = mysqlTable(
  'campaigns',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    objectiveId: ref('objective_id'),
    name: varchar('name', { length: 200 }).notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    state: mysqlEnum('state', ['draft', 'active', 'completed', 'archived']).notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_campaign_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_campaign_brand',
    }),
  ],
);

export const briefs = mysqlTable(
  'briefs',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    campaignId: ref('campaign_id'),
    audience: text('audience').notNull(),
    message: text('message').notNull(),
    offerFactIds: json('offer_fact_ids').$type<string[]>().notNull(),
    channelConnectionIds: json('channel_connection_ids').$type<string[]>().notNull(),
    constraints: json('constraints').$type<string[]>().notNull(),
    state: mysqlEnum('state', ['draft', 'accepted', 'in_progress', 'delivered', 'cancelled'])
      .notNull()
      .default('draft'),
    createdByKind: mysqlEnum('created_by_kind', ['user', 'agent']).notNull(),
    createdById: ref('created_by_id').notNull(),
    agentRunId: ref('agent_run_id'),
    recommendationId: ref('recommendation_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_brief_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_brief_brand',
    }),
  ],
);

export const contentPackages = mysqlTable(
  'content_packages',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    briefId: ref('brief_id'),
    title: varchar('title', { length: 200 }).notNull(),
    currentRevisionId: ref('current_revision_id'),
    state: mysqlEnum('state', ['draft', 'in_review', 'approved', 'scheduled', 'published', 'archived'])
      .notNull()
      .default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_package_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_package_brand',
    }),
  ],
);

/** Immutable snapshot of a package's copy and referenced creative revisions. State moves by transition only. */
export const contentRevisions = mysqlTable(
  'content_revisions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    packageId: ref('package_id').notNull(),
    number: int('number').notNull(),
    brandVersionId: ref('brand_version_id').notNull(),
    policyVersionId: ref('policy_version_id').notNull(),
    copy: json('copy').$type<CopyDocumentV1>().notNull(),
    creativeRevisionIds: json('creative_revision_ids').$type<string[]>().notNull(),
    factRefs: json('fact_refs').$type<string[]>().notNull(),
    contentHash: hash('content_hash').notNull(),
    state: mysqlEnum('state', ['draft', 'in_review', 'changes_requested', 'approved', 'superseded'])
      .notNull()
      .default('draft'),
    authorKind: mysqlEnum('author_kind', ['user', 'agent']).notNull(),
    authorId: ref('author_id').notNull(),
    agentRunId: ref('agent_run_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_content_rev_number').on(t.tenantId, t.packageId, t.number),
    uniqueIndex('uq_content_rev_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.packageId],
      foreignColumns: [contentPackages.tenantId, contentPackages.brandId, contentPackages.id],
      name: 'fk_content_rev_package',
    }),
  ],
);

export const channelVariants = mysqlTable(
  'channel_variants',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    contentRevisionId: ref('content_revision_id').notNull(),
    channelConnectionId: ref('channel_connection_id').notNull(),
    text: text('text').notNull(),
    altTexts: json('alt_texts').$type<string[]>().notNull(),
    settings: json('settings').$type<Record<string, unknown>>().notNull(),
    exportIds: json('export_ids').$type<string[]>().notNull(),
    capabilityVersion: int('capability_version').notNull(),
    validation: json('validation')
      .$type<{ ok: boolean; issues: Array<{ path?: string; issue: string }> }>()
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_variant_target').on(t.tenantId, t.contentRevisionId, t.channelConnectionId),
    uniqueIndex('uq_variant_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.contentRevisionId],
      foreignColumns: [contentRevisions.tenantId, contentRevisions.brandId, contentRevisions.id],
      name: 'fk_variant_revision',
    }),
  ],
);

export const creativeAttributes = mysqlTable(
  'creative_attributes',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    contentRevisionId: ref('content_revision_id'),
    channelVariantId: ref('channel_variant_id'),
    attributes: json('attributes').$type<CreativeAttributesV1>().notNull(),
    source: mysqlEnum('source', ['captured', 'human_corrected', 'inferred']).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('ix_creative_attr_revision').on(t.tenantId, t.contentRevisionId),
    index('ix_creative_attr_variant').on(t.tenantId, t.channelVariantId),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_creative_attr_brand',
    }),
  ],
);
