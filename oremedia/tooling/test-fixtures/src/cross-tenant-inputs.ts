import type { SeededTenant } from './seed';

/**
 * Spec 19.3: every procedure needs a fixture that points every ID field at the *foreign* tenant. A procedure
 * without an entry fails CI. `null` means the procedure takes no resource ids (documented per entry).
 * `expectEmpty` marks list/filter queries whose correct outcome is "no data" rather than an error.
 */
export interface CrossTenantFixture {
  buildInput: ((foreign: SeededTenant['ids']) => unknown) | null;
  reason?: string;
  expectEmpty?: boolean;
}

export const CROSS_TENANT_INPUTS: Record<string, CrossTenantFixture> = {
  'access.me': { buildInput: null, reason: 'no resource ids; tenant comes from the verified membership' },
  'access.listCompanies': { buildInput: null, reason: "projection over the caller's own memberships" },
  'access.switchCompany': { buildInput: (f) => ({ tenantId: f['tenantId'] }) },
  'access.members.invite': {
    buildInput: null,
    reason: "takes an email, no resource ids; the membership is created in the caller's tenant",
  },
  'access.members.setRole': {
    buildInput: (f) => ({ membershipId: f['membershipId'], expectedVersion: 0, role: 'admin' }),
  },
  'access.brandGrants.set': {
    buildInput: (f) => ({ membershipId: f['membershipId'], brandId: f['brandId'], roles: [] }),
  },
  'access.servicePrincipals.create': {
    buildInput: (f) => ({
      kind: 'agent',
      name: 'x',
      grants: [{ action: 'brand.read', brandIds: [f['brandId']] }],
      maxAutonomy: 'create',
    }),
  },
  'access.servicePrincipals.revoke': {
    buildInput: (f) => ({ servicePrincipalId: f['servicePrincipalId'], expectedVersion: 0 }),
  },
  'access.apiClients.create': {
    buildInput: (f) => ({ servicePrincipalId: f['servicePrincipalId'], scopes: [] }),
  },
  'access.apiClients.rotate': { buildInput: (f) => ({ apiClientId: f['apiClientId'] }) },
  'brand.create': {
    buildInput: null,
    reason: "no resource ids; the brand is created in the caller's tenant",
  },
  'brand.list': { buildInput: null, reason: "no input; lists only the caller's visible brands" },
  'brand.get': { buildInput: (f) => ({ brandId: f['brandId'] }) },
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
