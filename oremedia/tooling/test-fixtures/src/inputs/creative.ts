import type { CrossTenantFixture } from '../cross-tenant-inputs';
import { seedCreativeDocument } from './creative-seed';

/** One entry per creative.* procedure, every id pointing at the foreign tenant's rows from CREATIVE_SEED (spec 19.3). */
export const CREATIVE_INPUTS: Record<string, CrossTenantFixture> = {
  'creative.documents.create': { buildInput: (f) => ({ brandId: f['brandId'], title: 'Foreign document' }) },
  'creative.documents.get': { buildInput: (f) => ({ documentId: f['creativeDocumentId'] }) },
  'creative.revisions.list': {
    buildInput: (f) => ({ documentId: f['creativeDocumentId'], page: { limit: 50 } }),
  },
  'creative.revisions.get': {
    buildInput: (f) => ({ documentId: f['creativeDocumentId'], revisionId: f['creativeRevisionId'] }),
  },
  'creative.operations.applyBatch': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      baseRevisionId: f['creativeRevisionId'],
      operations: [{ op: 'setLock', pageId: 'page_1', elementId: f['creativeElementId'], locked: true }],
      summary: 'x',
      origin: 'user',
    }),
  },
  'creative.operations.propose': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      baseRevisionId: f['creativeRevisionId'],
      operations: [{ op: 'setLock', pageId: 'page_1', elementId: f['creativeElementId'], locked: true }],
      summary: 'x',
      origin: 'user',
    }),
  },
  'creative.renders.request': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      revisionId: f['creativeRevisionId'],
      formatKeys: ['square_1080'],
    }),
  },
  'creative.renders.get': { buildInput: (f) => ({ renderJobId: f['renderJobId'] }) },
  'creative.comments.add': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      revisionId: f['creativeRevisionId'],
      elementId: f['creativeElementId'],
      body: 'x',
    }),
  },
  'creative.comments.resolve': {
    buildInput: (f) => ({
      documentId: f['creativeDocumentId'],
      commentId: f['commentId'],
      expectedVersion: 0,
    }),
  },
  'creative.comments.list': {
    buildInput: (f) => ({ documentId: f['creativeDocumentId'], page: { limit: 50 } }),
  },
  'creative.templates.create': { buildInput: (f) => ({ brandId: f['brandId'], name: 'x' }) },
  'creative.templates.createVersion': {
    buildInput: (f) => ({
      templateId: f['templateId'],
      document: seedCreativeDocument(f['creativePublishedBrandVersionId'] ?? 'bv_foreign'),
      slots: [],
      formats: ['square_1080'],
    }),
  },
  'creative.templates.approve': {
    buildInput: (f) => ({
      templateId: f['templateId'],
      templateVersionId: f['templateVersionId'],
      expectedVersion: 0,
    }),
  },
  'creative.templates.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'creative.templates.get': {
    buildInput: (f) => ({ templateId: f['templateId'], templateVersionId: f['templateVersionId'] }),
  },
};
