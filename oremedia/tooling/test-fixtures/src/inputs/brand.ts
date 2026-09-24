import { emptyBrandSystemDocument } from '@oremedia/contracts/brand';
import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** Every id points at the foreign tenant (brand ids from the base seed, version/fact/objective/policy ids from BRAND_SEED). */
export const BRAND_INPUTS: Record<string, CrossTenantFixture> = {
  'brand.create': {
    buildInput: null,
    reason: "no resource ids; the brand is created in the caller's tenant",
  },
  'brand.list': { buildInput: null, reason: "no input; lists only the caller's visible brands" },
  'brand.get': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'brand.versions.createDraft': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'brand.versions.update': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      versionId: f['brandVersionId'],
      expectedVersion: 0,
      document: emptyBrandSystemDocument(),
    }),
  },
  'brand.versions.submitForReview': {
    buildInput: (f) => ({ brandId: f['brandId'], versionId: f['brandVersionId'], expectedVersion: 0 }),
  },
  'brand.versions.publish': {
    buildInput: (f) => ({ brandId: f['brandId'], versionId: f['brandVersionId'], expectedVersion: 0 }),
  },
  'brand.versions.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'brand.versions.get': { buildInput: (f) => ({ brandId: f['brandId'], versionId: f['brandVersionId'] }) },
  'brand.facts.propose': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      kind: 'claim',
      statement: 'x',
      evidence: [{ kind: 'other', ref: 'x' }],
    }),
  },
  'brand.facts.approve': {
    buildInput: (f) => ({ brandId: f['brandId'], factId: f['factId'], expectedVersion: 0 }),
  },
  'brand.facts.revoke': {
    buildInput: (f) => ({ brandId: f['brandId'], factId: f['factId'], expectedVersion: 0, reason: 'x' }),
  },
  'brand.facts.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'brand.objectives.set': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      name: 'x',
      primaryMetricKey: 'qualified_enquiries',
      guardrailMetricKeys: [],
      activeFrom: new Date().toISOString(),
    }),
  },
  'brand.objectives.list': {
    buildInput: (f) => ({ brandId: f['brandId'], activeOnly: false, page: { limit: 50 } }),
  },
  'brand.policy.createVersion': {
    buildInput: (f) => ({ brandId: f['brandId'], document: { schemaVersion: 1, reviewThresholds: {} } }),
  },
  'brand.policy.activate': {
    buildInput: (f) => ({ brandId: f['brandId'], policyVersionId: f['policyVersionId'], expectedVersion: 0 }),
  },
  'brand.policy.get': {
    buildInput: (f) => ({ brandId: f['brandId'], policyVersionId: f['policyVersionId'] }),
  },
  'brand.onboarding.start': {
    buildInput: null,
    reason:
      'agent run (Phase 4): the procedure is a stub that refuses with FORBIDDEN not_available_yet before touching any resource; it gets a real fixture with the agent runtime',
  },
};
