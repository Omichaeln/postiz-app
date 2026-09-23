import {
  bigint,
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
import type { Provenance } from '@oremedia/contracts/assets';
import { brandId, createdAt, hash, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

export const assets = mysqlTable(
  'assets',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: mysqlEnum('kind', [
      'logo',
      'photo',
      'icon',
      'illustration',
      'font',
      'video',
      'audio',
      'template',
      'reference',
    ]).notNull(),
    semanticRole: varchar('semantic_role', { length: 40 }),
    name: varchar('name', { length: 200 }).notNull(),
    currentVersionId: ref('current_version_id'),
    state: mysqlEnum('state', ['pending_review', 'approved', 'rejected', 'retired']).notNull(),
    rightsState: mysqlEnum('rights_state', ['unknown', 'recorded']).notNull().default('unknown'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_asset_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_asset_state').on(t.tenantId, t.brandId, t.state, t.kind),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_asset_brand',
    }),
  ],
);

export const assetVersions = mysqlTable(
  'asset_versions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    assetId: ref('asset_id').notNull(),
    number: int('number').notNull(),
    storageKey: varchar('storage_key', { length: 300 }).notNull(),
    contentHash: hash('content_hash').notNull(),
    mime: varchar('mime', { length: 100 }).notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    width: int('width'),
    height: int('height'),
    durationMs: int('duration_ms'),
    colourProfile: varchar('colour_profile', { length: 40 }),
    focalPoint: json('focal_point').$type<{ x: number; y: number }>(),
    altText: varchar('alt_text', { length: 1000 }),
    provenance: json('provenance').$type<Provenance>().notNull(), // upload/generated: model, prompt hash, inputs
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_asset_version_number').on(t.tenantId, t.assetId, t.number),
    uniqueIndex('uq_asset_version_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_asset_version_hash').on(t.tenantId, t.brandId, t.contentHash),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.assetId],
      foreignColumns: [assets.tenantId, assets.brandId, assets.id],
      name: 'fk_asset_version_asset',
    }),
  ],
);

export const assetDerivatives = mysqlTable(
  'asset_derivatives',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    assetVersionId: ref('asset_version_id').notNull(),
    purpose: varchar('purpose', { length: 40 }).notNull(), // thumbnail, preview, web, release
    transform: json('transform').$type<Record<string, unknown>>().notNull(),
    storageKey: varchar('storage_key', { length: 300 }).notNull(),
    contentHash: hash('content_hash').notNull(),
    mime: varchar('mime', { length: 100 }).notNull(),
    width: int('width'),
    height: int('height'),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_asset_derivative_version').on(t.tenantId, t.assetVersionId, t.purpose),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.assetVersionId],
      foreignColumns: [assetVersions.tenantId, assetVersions.brandId, assetVersions.id],
      name: 'fk_asset_derivative_version',
    }),
  ],
);

export const usageRights = mysqlTable(
  'usage_rights',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    assetId: ref('asset_id').notNull(),
    owner: varchar('owner', { length: 200 }).notNull(),
    licenceRef: varchar('licence_ref', { length: 500 }),
    permittedChannels: json('permitted_channels').$type<'all' | string[]>().notNull(),
    territories: json('territories').$type<'all' | string[]>().notNull(),
    expiresAt: ts('expires_at'),
    releases: json('releases').$type<Array<{ kind: string; ref: string }>>().notNull(),
    restrictions: json('restrictions').$type<string[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_usage_rights_asset').on(t.tenantId, t.assetId),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.assetId],
      foreignColumns: [assets.tenantId, assets.brandId, assets.id],
      name: 'fk_usage_rights_asset',
    }),
  ],
);

/** Cross-brand reuse inside one tenant (spec 5.1). brandId = source brand. */
export const assetGrants = mysqlTable(
  'asset_grants',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    assetId: ref('asset_id').notNull(),
    granteeBrandId: ref('grantee_brand_id').notNull(),
    purpose: varchar('purpose', { length: 40 }).notNull(),
    expiresAt: ts('expires_at'),
    createdByUserId: ref('created_by_user_id').notNull(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_asset_grant').on(t.tenantId, t.assetId, t.granteeBrandId, t.purpose),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.assetId],
      foreignColumns: [assets.tenantId, assets.brandId, assets.id],
      name: 'fk_asset_grant_asset',
    }),
    foreignKey({
      columns: [t.tenantId, t.granteeBrandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_asset_grant_grantee',
    }),
  ],
);

export const assetUsages = mysqlTable(
  'asset_usages',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    assetVersionId: ref('asset_version_id').notNull(),
    usedByType: varchar('used_by_type', { length: 40 }).notNull(), // creative_revision, rendered_export, publication
    usedById: ref('used_by_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_asset_usage').on(t.tenantId, t.assetVersionId, t.usedByType, t.usedById),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.assetVersionId],
      foreignColumns: [assetVersions.tenantId, assetVersions.brandId, assetVersions.id],
      name: 'fk_asset_usage_version',
    }),
  ],
);

export const uploadIntents = mysqlTable(
  'upload_intents',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: mysqlEnum('kind', [
      'logo',
      'photo',
      'icon',
      'illustration',
      'font',
      'video',
      'audio',
      'template',
      'reference',
    ]).notNull(),
    declaredMime: varchar('declared_mime', { length: 100 }).notNull(),
    declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),
    maxBytes: bigint('max_bytes', { mode: 'number' }).notNull(),
    storageKey: varchar('storage_key', { length: 300 }).notNull(),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    state: mysqlEnum('state', ['issued', 'uploaded', 'quarantined', 'accepted', 'rejected']).notNull(),
    rejectionReason: varchar('rejection_reason', { length: 200 }),
    resultAssetId: ref('result_asset_id'),
    createdByUserId: ref('created_by_user_id').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('ix_upload_intent_state').on(t.tenantId, t.brandId, t.state),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_upload_intent_brand',
    }),
  ],
);

export const collections = mysqlTable(
  'collections',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    assetIds: json('asset_ids').$type<string[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_collection_brand',
    }),
  ],
);
