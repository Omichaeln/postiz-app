import type { CrossTenantFixture } from '../cross-tenant-inputs';

const design = (contentRevisionId: string) => ({
  v: 1,
  hypothesis: 'foreign hypothesis',
  mode: 'structured_comparison',
  variants: [
    { label: 'control', contentRevisionId, allocationWeight: 1 },
    { label: 'treatment', contentRevisionId, allocationWeight: 1 },
  ],
  primaryMetricKey: 'qualified_enquiries',
  guardrailMetricKeys: [],
  allocationMethod: 'matched_slots',
  unitType: 'publication_slot',
  minSamplePerArm: 10,
  observationWindowHours: 24,
  stoppingRule: { kind: 'fixed_horizon', alpha: 0.05 },
});

/** One entry per experiments.* procedure, every id pointing at the foreign tenant's rows from EXPERIMENTS_SEED (spec 19.3). */
export const EXPERIMENTS_INPUTS: Record<string, CrossTenantFixture> = {
  'experiments.create': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      recommendationId: f['recommendationId'],
      design: design(f['contentRevisionId'] ?? 'crev_foreign'),
    }),
  },
  'experiments.preRegister': { buildInput: (f) => ({ experimentId: f['experimentId'], expectedVersion: 0 }) },
  'experiments.start': { buildInput: (f) => ({ experimentId: f['experimentId'], expectedVersion: 0 }) },
  'experiments.stop': { buildInput: (f) => ({ experimentId: f['experimentId'], expectedVersion: 0 }) },
  'experiments.results.compute': {
    buildInput: (f) => ({
      experimentId: f['experimentId'],
      preRegistrationHash: 'a'.repeat(64),
      observations: [
        { variantId: f['experimentVariantId'], n: 10, x: 1 },
        { variantId: f['experimentVariantId2'], n: 10, x: 2 },
      ],
    }),
  },
  'experiments.results.get': { buildInput: (f) => ({ experimentId: f['experimentId'] }) },
  'experiments.assign': {
    buildInput: (f) => ({ experimentId: f['experimentId'], unitType: 'visitor', unitIdHash: 'f'.repeat(32) }),
  },
  'experiments.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'experiments.get': { buildInput: (f) => ({ experimentId: f['experimentId'] }) },
};
