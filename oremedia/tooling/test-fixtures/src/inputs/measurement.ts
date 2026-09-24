import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** One entry per measurement.* procedure, every id pointing at the foreign tenant's rows from MEASUREMENT_SEED (spec 19.3). */
export const MEASUREMENT_INPUTS: Record<string, CrossTenantFixture> = {
  'measurement.definitions.list': {
    buildInput: null,
    reason: 'no resource ids; lists global definitions plus the caller’s own tenant definitions',
  },
  'measurement.definitions.get': { buildInput: (f) => ({ definitionId: f['metricDefinitionId'] }) },
  'measurement.definitions.create': {
    buildInput: null,
    reason: 'no resource ids; the definition is created in the caller’s tenant',
  },
  'measurement.metrics.query': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      subjectType: 'publication',
      subjectIds: [f['publicationId']],
      metricKeys: ['impressionCount'],
      windowStart: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
    }),
  },
  'measurement.quality.get': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      publicationId: f['publicationId'],
      windowStart: new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
    }),
  },
  'measurement.links.list': {
    buildInput: (f) => ({ brandId: f['brandId'], variantId: f['channelVariantId'], page: { limit: 50 } }),
  },
  'measurement.attributes.get': { buildInput: (f) => ({ attributeId: f['creativeAttributesId'] }) },
  'measurement.attributes.correct': {
    buildInput: (f) => ({
      attributeId: f['creativeAttributesId'],
      expectedVersion: 0,
      attributes: { cta: 'x' },
    }),
  },
};
