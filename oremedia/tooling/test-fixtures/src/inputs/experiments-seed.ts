import { experimentVariants, experiments } from '@oremedia/db/schema/experiments';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** Per tenant, on brand 1: one designed experiment with two variants, so a foreign caller has every experiment id to try. */
export const EXPERIMENTS_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const experimentId = newId('experiment');
  const experimentVariantId = newId('experimentVariant');
  const experimentVariantId2 = newId('experimentVariant');
  await db.insert(experiments).values({
    id: experimentId,
    tenantId,
    brandId,
    recommendationId: null,
    hypothesis: 'Seeded hypothesis',
    mode: 'structured_comparison',
    primaryMetricKey: 'qualified_enquiries',
    guardrailMetricKeys: [],
    allocationMethod: 'matched_slots',
    minSample: { perArm: 10 },
    observationWindowHours: { hours: 24 },
    stoppingRule: {
      rule: { kind: 'fixed_horizon', alpha: 0.05 },
      unitType: 'publication_slot',
      guardrailThresholds: {},
    },
    preRegistration: null,
    preRegistrationHash: null,
    preRegisteredAt: null,
    state: 'designed',
    startedAt: null,
    stoppedAt: null,
    createdByKind: 'user',
    createdById: ownerUserId,
  });
  await db.insert(experimentVariants).values([
    {
      id: experimentVariantId,
      tenantId,
      brandId,
      experimentId,
      label: 'control',
      contentRevisionId: newId('contentRevision'),
      allocationWeight: 1,
    },
    {
      id: experimentVariantId2,
      tenantId,
      brandId,
      experimentId,
      label: 'treatment',
      contentRevisionId: newId('contentRevision'),
      allocationWeight: 1,
    },
  ]);
  return { experimentId, experimentVariantId, experimentVariantId2 };
};
