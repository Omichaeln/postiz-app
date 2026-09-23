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
import type {
  CreativeDocumentV1,
  OperationBatch,
  RenderManifest,
  RenderValidationResult,
} from '@oremedia/contracts/creative';
import { brandId, createdAt, hash, id, ref, tenantId, updatedAt, version } from './_columns';
import { brands } from './brand';

export const creativeDocuments = mysqlTable(
  'creative_documents',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    contentPackageId: ref('content_package_id'),
    title: varchar('title', { length: 200 }).notNull(),
    currentRevisionId: ref('current_revision_id'),
    schemaVersion: int('schema_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_creative_doc_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_creative_doc_brand',
    }),
  ],
);

/** Insert-only. */
export const creativeRevisions = mysqlTable(
  'creative_revisions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    documentId: ref('document_id').notNull(),
    parentRevisionId: ref('parent_revision_id'),
    number: int('number').notNull(),
    brandVersionId: ref('brand_version_id').notNull(),
    agentRunId: ref('agent_run_id'),
    authorKind: mysqlEnum('author_kind', ['user', 'agent']).notNull(),
    authorId: ref('author_id').notNull(),
    changeSummary: varchar('change_summary', { length: 500 }).notNull(),
    operations: json('operations').$type<OperationBatch>().notNull(), // what changed from parent
    snapshot: json('snapshot').$type<CreativeDocumentV1>().notNull(), // full document at this revision
    contentHash: hash('content_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_rev_number').on(t.tenantId, t.documentId, t.number),
    uniqueIndex('uq_rev_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.documentId],
      foreignColumns: [creativeDocuments.tenantId, creativeDocuments.brandId, creativeDocuments.id],
      name: 'fk_rev_document',
    }),
  ],
);

/** Insert-only. Approved exports are immutable and are what gets published (spec 2.1.8). */
export const renderedExports = mysqlTable(
  'rendered_exports',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    revisionId: ref('revision_id').notNull(),
    pageId: varchar('page_id', { length: 40 }).notNull(),
    formatKey: varchar('format_key', { length: 40 }).notNull(), // 'ig_feed_4x5', 'li_1200x627', ...
    mime: varchar('mime', { length: 40 }).notNull(),
    width: int('width').notNull(),
    height: int('height').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    storageKey: varchar('storage_key', { length: 300 }).notNull(),
    contentHash: hash('content_hash').notNull(),
    rendererVersion: varchar('renderer_version', { length: 40 }).notNull(),
    manifest: json('manifest').$type<RenderManifest>().notNull(), // fonts + asset versions + hashes
    validation: json('validation').$type<RenderValidationResult>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ix_export_revision').on(t.tenantId, t.revisionId, t.formatKey),
    uniqueIndex('uq_export_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.revisionId],
      foreignColumns: [creativeRevisions.tenantId, creativeRevisions.brandId, creativeRevisions.id],
      name: 'fk_export_revision',
    }),
  ],
);

export const elementComments = mysqlTable(
  'element_comments',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    documentId: ref('document_id').notNull(),
    revisionId: ref('revision_id').notNull(),
    elementId: varchar('element_id', { length: 40 }).notNull(),
    body: text('body').notNull(),
    authorKind: mysqlEnum('author_kind', ['user', 'external_reviewer', 'agent']).notNull(),
    authorId: ref('author_id').notNull(),
    state: mysqlEnum('state', ['open', 'resolved', 'outdated']).notNull().default('open'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('ix_comment_document').on(t.tenantId, t.documentId, t.state),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.documentId],
      foreignColumns: [creativeDocuments.tenantId, creativeDocuments.brandId, creativeDocuments.id],
      name: 'fk_comment_document',
    }),
  ],
);

export const templates = mysqlTable(
  'templates',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    name: varchar('name', { length: 200 }).notNull(),
    currentVersionId: ref('current_version_id'),
    state: mysqlEnum('state', ['draft', 'active', 'retired']).notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_template_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_template_brand',
    }),
  ],
);

export const templateVersions = mysqlTable(
  'template_versions',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    templateId: ref('template_id').notNull(),
    number: int('number').notNull(),
    slots: json('slots')
      .$type<Array<{ key: string; elementId: string; kind: string; required: boolean }>>()
      .notNull(),
    constraints: json('constraints').$type<Record<string, unknown>>().notNull(),
    formats: json('formats').$type<string[]>().notNull(),
    document: json('document').$type<CreativeDocumentV1>().notNull(),
    contentHash: hash('content_hash').notNull(),
    state: mysqlEnum('state', ['draft', 'approved', 'retired']).notNull().default('draft'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_template_version_number').on(t.tenantId, t.templateId, t.number),
    uniqueIndex('uq_template_version_tbi').on(t.tenantId, t.brandId, t.id),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.templateId],
      foreignColumns: [templates.tenantId, templates.brandId, templates.id],
      name: 'fk_template_version_template',
    }),
  ],
);

export const renderJobs = mysqlTable(
  'render_jobs',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    revisionId: ref('revision_id').notNull(),
    formatKeys: json('format_keys').$type<string[]>().notNull(),
    state: mysqlEnum('state', ['pending', 'rendering', 'ready', 'failed']).notNull().default('pending'),
    attempts: int('attempts').notNull().default(0),
    error: varchar('error', { length: 2000 }),
    requestedByKind: mysqlEnum('requested_by_kind', ['user', 'agent', 'system']).notNull(),
    requestedById: ref('requested_by_id').notNull(),
    exportIds: json('export_ids').$type<string[]>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('ix_render_job_revision').on(t.tenantId, t.revisionId),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.revisionId],
      foreignColumns: [creativeRevisions.tenantId, creativeRevisions.brandId, creativeRevisions.id],
      name: 'fk_render_job_revision',
    }),
  ],
);
