import { creativeAttributes } from '@oremedia/db/schema/content';
import { metricDefinitions, metricSnapshots, trackedLinks } from '@oremedia/db/schema/measurement';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/**
 * Per tenant, on brand 1: a tenant metric definition, a raw snapshot (unavailable, so a null value), a tracked link
 * and a creative attributes row, so a foreign caller has every measurement id to try (spec 19.3 measurement.*).
 */
export const MEASUREMENT_SEED: SeedExtension = async (db, { tenantId, brandIds }) => {
  const brandId = brandIds[0];
  const metricDefinitionId = newId('metricDefinition');
  const metricSnapshotId = newId('metricSnapshot');
  const trackedLinkId = newId('trackedLink');
  const creativeAttributesId = newId('creativeAttributes');
  const now = new Date();
  await db.insert(metricDefinitions).values({
    id: metricDefinitionId,
    tenantId,
    key: 'qualified_enquiries',
    providerKey: null,
    nativeName: 'qualified_enquiries',
    unit: 'count',
    aggregation: 'sum',
    comparableGroup: 'conversions',
    definitionVersion: 1,
    separatesPaidOrganic: false,
    definition: 'Seeded tenant metric',
  });
  await db.insert(metricSnapshots).values({
    id: metricSnapshotId,
    tenantId,
    brandId,
    subjectType: 'publication',
    subjectId: newId('publication'),
    metricKey: 'impressionCount',
    value: null,
    series: null,
    windowStart: new Date(now.getTime() - 3600_000),
    windowEnd: now,
    fetchedAt: now,
    source: 'fixture_provider@v1',
    completeness: 'unavailable',
    definitionVersion: 1,
    numeratorSnapshotId: null,
    denominatorSnapshotId: null,
    brandTimezone: 'UTC',
  });
  await db.insert(trackedLinks).values({
    id: trackedLinkId,
    tenantId,
    brandId,
    publicationId: null,
    variantId: newId('channelVariant'),
    experimentId: null,
    experimentVariantId: null,
    destination: 'https://example.test/offer?utm_source=oremedia',
    utm: { utm_source: 'oremedia' },
    shortCode: `s${trackedLinkId.slice(-9)}`,
  });
  await db.insert(creativeAttributes).values({
    id: creativeAttributesId,
    tenantId,
    brandId,
    contentRevisionId: newId('contentRevision'),
    channelVariantId: null,
    attributes: { hookType: 'statement', topic: 'seeded' },
    source: 'captured',
  });
  return { metricDefinitionId, metricSnapshotId, trackedLinkId, creativeAttributesId };
};
