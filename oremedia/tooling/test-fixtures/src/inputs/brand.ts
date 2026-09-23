import type { CrossTenantFixture } from '../cross-tenant-inputs';

export const BRAND_INPUTS: Record<string, CrossTenantFixture> = {
  'brand.create': {
    buildInput: null,
    reason: "no resource ids; the brand is created in the caller's tenant",
  },
  'brand.list': { buildInput: null, reason: "no input; lists only the caller's visible brands" },
  'brand.get': { buildInput: (f) => ({ brandId: f['brandId'] }) },
};
