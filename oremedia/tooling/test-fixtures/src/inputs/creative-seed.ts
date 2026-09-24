import { and, eq } from 'drizzle-orm';
import { emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import type { CreativeDocumentV1, CreativePage } from '@oremedia/contracts/creative';
import { brandVersions, brands } from '@oremedia/db/schema/brand';
import {
  creativeDocuments,
  creativeRevisions,
  elementComments,
  renderJobs,
  templateVersions,
  templates,
} from '@oremedia/db/schema/creative';
import { hashCanonical } from '@oremedia/domain/hash';
import { newElementId, newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** A minimal valid creative document (spec 11.2): one square page with one headline element. */
export function seedCreativeDocument(brandVersionId: string, elementId = newElementId()): CreativeDocumentV1 {
  const page: CreativePage = {
    id: 'page_1',
    name: 'Feed',
    formatKey: 'square_1080',
    width: 1080,
    height: 1080,
    layoutConstraints: [],
    elements: [
      {
        id: elementId,
        name: 'Headline',
        type: 'text',
        locked: false,
        visible: true,
        opacity: 1,
        protected: false,
        transform: { x: 80, y: 80, width: 920, height: 120, rotation: 0 },
        text: 'Seeded headline',
        style: {
          typeRole: 'display',
          fontAssetVersionId: 'av_font',
          weight: 600,
          sizePx: 64,
          lineHeight: 1.2,
          tracking: 0,
          align: 'left',
          overflow: 'error',
        },
        factRefs: [],
      },
    ],
  };
  return { schemaVersion: 1, brandVersionId, pages: [page], variants: [] };
}

/**
 * Per tenant, on brand 1: a published brand version (BRAND_SEED only creates a draft), one document with its
 * revision 1, one open element comment, one template with a draft version and one pending render job, so a
 * foreign caller has every creative id to try (spec 19.3).
 */
export const CREATIVE_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const creativePublishedBrandVersionId = newId('brandVersion');
  const brandDocument = emptyBrandSystemDocument();
  await db.insert(brandVersions).values({
    id: creativePublishedBrandVersionId,
    tenantId,
    brandId,
    number: 2,
    state: 'published',
    document: brandDocument,
    contentHash: hashCanonical(brandDocument),
    publishedAt: new Date(),
    publishedByUserId: ownerUserId,
  });
  await db
    .update(brands)
    .set({ publishedVersionId: creativePublishedBrandVersionId })
    .where(and(eq(brands.tenantId, tenantId), eq(brands.id, brandId)));

  const creativeElementId = newElementId();
  const document = seedCreativeDocument(creativePublishedBrandVersionId, creativeElementId);
  const creativeDocumentId = newId('creativeDocument');
  const creativeRevisionId = newId('creativeRevision');
  await db.insert(creativeDocuments).values({
    id: creativeDocumentId,
    tenantId,
    brandId,
    title: 'Seeded document',
    currentRevisionId: creativeRevisionId,
    schemaVersion: 1,
  });
  await db.insert(creativeRevisions).values({
    id: creativeRevisionId,
    tenantId,
    brandId,
    documentId: creativeDocumentId,
    parentRevisionId: null,
    number: 1,
    brandVersionId: creativePublishedBrandVersionId,
    authorKind: 'user',
    authorId: ownerUserId,
    changeSummary: 'Initial document',
    operations: {
      baseRevisionId: '',
      operations: document.pages.map((page, index) => ({ op: 'addPage', page, index })),
      summary: 'Initial document',
      origin: 'user',
    },
    snapshot: document,
    contentHash: hashCanonical(document),
  });
  const commentId = newId('elementComment');
  await db.insert(elementComments).values({
    id: commentId,
    tenantId,
    brandId,
    documentId: creativeDocumentId,
    revisionId: creativeRevisionId,
    elementId: creativeElementId,
    body: 'Seeded comment',
    authorKind: 'user',
    authorId: ownerUserId,
    state: 'open',
  });
  const templateId = newId('template');
  const templateVersionId = newId('templateVersion');
  await db.insert(templates).values({
    id: templateId,
    tenantId,
    brandId,
    name: 'Seeded template',
    currentVersionId: null,
    state: 'draft',
  });
  await db.insert(templateVersions).values({
    id: templateVersionId,
    tenantId,
    brandId,
    templateId,
    number: 1,
    slots: [],
    constraints: {},
    formats: ['square_1080'],
    document,
    contentHash: hashCanonical(document),
    state: 'draft',
  });
  const renderJobId = newId('renderJob');
  await db.insert(renderJobs).values({
    id: renderJobId,
    tenantId,
    brandId,
    revisionId: creativeRevisionId,
    formatKeys: ['square_1080'],
    state: 'pending',
    attempts: 0,
    requestedByKind: 'user',
    requestedById: ownerUserId,
  });
  return {
    creativePublishedBrandVersionId,
    creativeDocumentId,
    creativeRevisionId,
    creativeElementId,
    commentId,
    templateId,
    templateVersionId,
    renderJobId,
  };
};
