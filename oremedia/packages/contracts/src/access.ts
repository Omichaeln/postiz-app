import { z } from 'zod';
import { MembershipRole } from './tenancy';
import { ServicePrincipalGrant } from './policy';
import { AutonomyMode } from './tenancy';

export const MembershipStatus = z.enum(['invited', 'active', 'disabled']);
export const TenantStatus = z.enum(['active', 'suspended', 'closing']);
export const UserStatus = z.enum(['active', 'disabled', 'deleted']);
export const ServicePrincipalKind = z.enum(['agent', 'api_client', 'mcp_client', 'integration']);
export const SupportSessionMode = z.enum(['read_only', 'escalated']);

export const TenantCreate = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]{3,80}$/),
});
export const MemberInvite = z.object({
  email: z.string().email(),
  role: MembershipRole,
  allBrands: z.boolean().default(false),
});
export const MemberSetRole = z.object({
  membershipId: z.string(),
  expectedVersion: z.number().int(),
  role: MembershipRole,
  allBrands: z.boolean().optional(),
});
export const BrandGrantSet = z.object({
  membershipId: z.string(),
  brandId: z.string(),
  roles: z.array(z.string()).max(10),
});
export const ServicePrincipalCreate = z.object({
  kind: ServicePrincipalKind,
  name: z.string().min(1).max(120),
  grants: z.array(ServicePrincipalGrant).max(100),
  maxAutonomy: AutonomyMode.default('create'),
});
export const ServicePrincipalRevoke = z.object({
  servicePrincipalId: z.string(),
  expectedVersion: z.number().int(),
});
export const ApiClientCreate = z.object({
  servicePrincipalId: z.string(),
  scopes: z.array(z.string()).max(50),
  expiresAt: z.string().datetime().optional(),
});
export const ApiClientRotate = z.object({ apiClientId: z.string() });
export const ExternalLinkCreate = z.object({
  reviewRequestId: z.string(),
  email: z.string().email(),
  expiresAt: z.string().datetime(),
});
export const ExternalLinkRevoke = z.object({ linkId: z.string() });
export const SupportSessionOpen = z.object({
  tenantId: z.string(),
  reason: z.string().min(10).max(1000),
  ticketRef: z.string().min(1).max(80),
  consentRecorded: z.boolean(),
  durationMinutes: z.number().int().min(5).max(240).default(60),
});
