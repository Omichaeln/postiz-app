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
import type {
  BrandSystemDocumentV1,
  DesignTokenSetV1,
  EvidenceRef,
  PolicyDocumentV1,
} from '@oremedia/contracts/brand';
import { brandId, createdAt, hash, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { tenants } from './access';

export const brands = mysqlTable(
  'brands',
  {
    id: id(),
    tenantId: tenantId(),
    name: varchar('name', { length: 200 }).notNull(),
    timezone: varchar('timezone', { length: 64 }).notNull(),
    defaultLocale: varchar('default_locale', { length: 16 }).notNull(),
    publishedVersionId: ref('published_version_id'),
    activePolicyVersionId: ref('active_policy_version_id'),
    status: mysqlEnum('status', ['setup', 'active', 'archived']).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_brand_tenant_id').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id], name: 'fk_brand_tenant' }),
  ],
);

export const brandVersions = mysqlTable(
  'brand_versions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    number: int('number').notNull(),
    state: mysqlEnum('state', ['draft', 'in_review', 'published', 'retired']).notNull(),
    document: json('document').$type<BrandSystemDocumentV1>().notNull(), // tokens, voice, logo rules, patterns, channel guidance
    contentHash: hash('content_hash').notNull(),
    publishedAt: ts('published_at'),
    publishedByUserId: ref('published_by_user_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_brand_version_number').on(t.tenantId, t.brandId, t.number),
    uniqueIndex('uq_brand_version_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_brand_version_brand',
    }),
  ],
);

export const designTokens = mysqlTable(
  'design_tokens',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    brandVersionId: ref('brand_version_id').notNull(),
    tokenSet: json('token_set').$type<DesignTokenSetV1>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_design_tokens_version').on(t.tenantId, t.brandVersionId),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.brandVersionId],
      foreignColumns: [brandVersions.tenantId, brandVersions.brandId, brandVersions.id],
      name: 'fk_design_tokens_version',
    }),
  ],
);

export const approvedFacts = mysqlTable(
  'approved_facts',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: mysqlEnum('kind', [
      'product',
      'claim',
      'offer',
      'contact',
      'price',
      'statistic',
      'legal',
    ]).notNull(),
    statement: text('statement').notNull(),
    evidence: json('evidence').$type<EvidenceRef[]>().notNull(), // source doc/asset refs, URLs, reviewer
    validFrom: ts('valid_from'),
    validUntil: ts('valid_until'), // expired offers block release
    state: mysqlEnum('state', ['proposed', 'approved', 'revoked']).notNull(),
    proposedByKind: mysqlEnum('proposed_by_kind', ['user', 'agent']).notNull(),
    proposedById: ref('proposed_by_id').notNull(),
    approvedByUserId: ref('approved_by_user_id'),
    revokedByUserId: ref('revoked_by_user_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_fact_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_fact_state').on(t.tenantId, t.brandId, t.state),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_fact_brand',
    }),
  ],
);

export const brandObjectives = mysqlTable(
  'brand_objectives',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    name: varchar('name', { length: 160 }).notNull(),
    primaryMetricKey: varchar('primary_metric_key', { length: 80 }).notNull(), // e.g. 'qualified_enquiries'
    guardrailMetricKeys: json('guardrail_metric_keys').$type<string[]>().notNull(),
    engagementQualityWeights: json('engagement_quality_weights').$type<Record<string, number>>(),
    activeFrom: ts('active_from').notNull(),
    activeUntil: ts('active_until'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_objective_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_objective_brand',
    }),
  ],
);

export const policyVersions = mysqlTable(
  'policy_versions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    number: int('number').notNull(),
    document: json('document').$type<PolicyDocumentV1>().notNull(), // review_thresholds, restricted_topics, require_distinct_approver, prohibited_terms
    state: mysqlEnum('state', ['draft', 'active', 'retired']).notNull(),
    createdByUserId: ref('created_by_user_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_policy_version_number').on(t.tenantId, t.brandId, t.number),
    uniqueIndex('uq_policy_version_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_policy_version_brand',
    }),
  ],
);
