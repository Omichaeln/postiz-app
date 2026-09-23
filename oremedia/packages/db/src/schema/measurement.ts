import {
  boolean,
  double,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { brandId, createdAt, id, micros, ref, tenantId, ts } from './_columns';
import { brands } from './brand';

/** Global + tenant (spec 6.3): global rows have tenant_id NULL. Listed in GLOBAL_TABLES. */
export const metricDefinitions = mysqlTable(
  'metric_definitions',
  {
    id: id(),
    tenantId: varchar('tenant_id', { length: 32 }),
    key: varchar('key', { length: 80 }).notNull(),
    providerKey: varchar('provider_key', { length: 40 }),
    nativeName: varchar('native_name', { length: 120 }).notNull(),
    unit: varchar('unit', { length: 40 }).notNull(),
    aggregation: mysqlEnum('aggregation', ['sum', 'max', 'last', 'avg', 'series']).notNull(),
    comparableGroup: varchar('comparable_group', { length: 40 }).notNull(),
    definitionVersion: int('definition_version').notNull(),
    separatesPaidOrganic: boolean('separates_paid_organic').notNull().default(false),
    definition: varchar('definition', { length: 1000 }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_metric_definition').on(t.key, t.providerKey, t.definitionVersion, t.tenantId)],
);

/** Insert-only. Unavailable is stored as a row with no value, never as zero (spec 15.1). */
export const metricSnapshots = mysqlTable(
  'metric_snapshots',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    subjectType: mysqlEnum('subject_type', ['publication', 'channel', 'campaign', 'link']).notNull(),
    subjectId: ref('subject_id').notNull(),
    metricKey: varchar('metric_key', { length: 80 }).notNull(),
    value: double('value'),
    series: json('series').$type<Array<{ at: string; value: number }>>(),
    windowStart: ts('window_start').notNull(),
    windowEnd: ts('window_end').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    source: varchar('source', { length: 80 }).notNull(), // provider key + API version
    completeness: mysqlEnum('completeness', ['complete', 'partial', 'unavailable']).notNull(),
    definitionVersion: int('definition_version').notNull(),
    numeratorSnapshotId: ref('numerator_snapshot_id'),
    denominatorSnapshotId: ref('denominator_snapshot_id'),
    brandTimezone: varchar('brand_timezone', { length: 64 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_snapshot_subject').on(
      t.tenantId,
      t.brandId,
      t.subjectType,
      t.subjectId,
      t.metricKey,
      t.fetchedAt,
    ),
    index('ix_snapshot_window').on(t.tenantId, t.brandId, t.metricKey, t.windowStart),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_snapshot_brand',
    }),
  ],
);

export const trackedLinks = mysqlTable(
  'tracked_links',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    publicationId: ref('publication_id'),
    variantId: ref('variant_id'),
    experimentId: ref('experiment_id'),
    experimentVariantId: ref('experiment_variant_id'),
    destination: varchar('destination', { length: 2000 }).notNull(),
    utm: json('utm').$type<Record<string, string>>().notNull(),
    shortCode: varchar('short_code', { length: 16 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_tracked_link_code').on(t.shortCode),
    index('ix_tracked_link_publication').on(t.tenantId, t.publicationId),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_tracked_link_brand',
    }),
  ],
);

/** Insert-only click log for tracked links (buffered writes from the redirector). */
export const linkClicks = mysqlTable(
  'link_clicks',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    trackedLinkId: ref('tracked_link_id').notNull(),
    visitorHash: varchar('visitor_hash', { length: 64 }).notNull(),
    occurredAt: ts('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_link_click_link').on(t.tenantId, t.trackedLinkId, t.occurredAt)],
);

export const conversions = mysqlTable(
  'conversions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    source: mysqlEnum('source', ['crm', 'pixel', 'form']).notNull(),
    externalRef: varchar('external_ref', { length: 200 }).notNull(),
    attributedLinkId: ref('attributed_link_id'),
    attributionMethod: varchar('attribution_method', { length: 40 }).notNull().default('last_tracked_touch'),
    qualified: boolean('qualified').notNull().default(false),
    valueMicros: micros('value_micros'),
    currency: varchar('currency', { length: 3 }),
    occurredAt: ts('occurred_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_conversion_ref').on(t.tenantId, t.source, t.externalRef),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_conversion_brand',
    }),
  ],
);
