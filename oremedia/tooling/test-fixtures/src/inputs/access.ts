import type { CrossTenantFixture } from '../cross-tenant-inputs';

export const ACCESS_INPUTS: Record<string, CrossTenantFixture> = {
  'access.me': { buildInput: null, reason: 'no resource ids; tenant comes from the verified membership' },
  'access.listCompanies': { buildInput: null, reason: "projection over the caller's own memberships" },
  'access.switchCompany': {
    buildInput: (f) => ({ tenantId: f['tenantId'] }),
    reason: 'tenant ids are not secret; a non-member is told so',
    expectCode: 'FORBIDDEN',
  },
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
};
