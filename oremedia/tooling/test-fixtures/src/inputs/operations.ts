import type { CrossTenantFixture } from '../cross-tenant-inputs';

export const OPERATIONS_INPUTS: Record<string, CrossTenantFixture> = {
  'operations.audit.query': {
    buildInput: (f) => ({ query: { resourceId: f['membershipId'] }, page: { limit: 50 } }),
    expectEmpty: true,
  },
  'operations.flags.snapshot': { buildInput: null, reason: 'no input' },
  'operations.killSwitch.get': { buildInput: (f) => ({ scope: 'release_dispatch', brandId: f['brandId'] }) },
  'operations.killSwitch.set': {
    buildInput: (f) => ({ scope: 'release_dispatch', brandId: f['brandId'], engaged: true, reason: 'x' }),
  },
  'operations.deletion.request': {
    buildInput: (f) => ({ subjectType: 'brand', subjectId: f['brandId'], reason: 'x' }),
  },
};
