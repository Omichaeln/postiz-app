import { z } from 'zod';
import { AutonomyMode, MembershipRole } from './tenancy';

/** Spec 5.5: the closed action vocabulary. */
export const Action = z.enum([
  'brand.read',
  'brand.edit_standards',
  'brand.publish_version',
  'asset.read',
  'asset.upload',
  'asset.approve',
  'asset.manage_rights',
  'creative.read',
  'creative.edit',
  'creative.render',
  'content.plan',
  'content.edit',
  'review.request',
  'review.decide',
  'publication.schedule',
  'publication.cancel',
  'publication.delete_remote',
  'channel.connect',
  'channel.manage',
  'mandate.manage',
  'agent.start_run',
  'agent.cancel_run',
  'skill.author',
  'skill.publish',
  'insight.read',
  'experiment.manage',
  'playbook.approve',
  'inbox.respond',
  'billing.manage',
  'membership.manage',
  'audit.read',
]);
export type Action = z.infer<typeof Action>;

export const Obligation = z.discriminatedUnion('type', [
  z.object({ type: z.literal('requires_approval'), scope: z.string() }),
  z.object({ type: z.literal('two_person_rule'), scope: z.string() }),
  z.object({ type: z.literal('propose_only') }),
]);
export type Obligation = z.infer<typeof Obligation>;

export interface Decision {
  allowed: boolean;
  reason: string; // machine-readable: 'ok', 'tenant_mismatch', 'membership_inactive', 'brand_not_granted', 'role_missing', ...
  obligations?: Obligation[];
}

/** Service-principal grant: action + brand + channel scope (spec 6.2 service_principals.grants). */
export const ServicePrincipalGrant = z.object({
  action: Action,
  brandIds: z.union([z.literal('all'), z.array(z.string()).max(200)]),
  channelConnectionIds: z.union([z.literal('all'), z.array(z.string()).max(200)]).optional(),
});
export type ServicePrincipalGrant = z.infer<typeof ServicePrincipalGrant>;

export const EntitlementFeature = z.enum([
  'brands',
  'seats',
  'channels',
  'generation_budget_micros_month',
  'render_minutes_month',
  'analyst_frequency',
  'experiments',
  'inbox_seats',
  'managed_autopublish',
]);
export type EntitlementFeature = z.infer<typeof EntitlementFeature>;

export interface EntitlementSet {
  /** Numeric limits; absent = not entitled. */
  limits: Partial<Record<EntitlementFeature, number>>;
  /** Boolean features. */
  features: Partial<Record<EntitlementFeature, boolean>>;
  /** Usage counters resolved at the same time, for limit comparison. */
  usage: Partial<Record<EntitlementFeature, number>>;
}

export interface ResolvedActorUser {
  kind: 'user';
  id: string;
  tenantId: string;
  membershipId: string;
  membershipStatus: 'invited' | 'active' | 'disabled';
  role: MembershipRole;
  allBrands: boolean;
  brandGrants: ReadonlyArray<{ brandId: string; roles: readonly string[] }>;
  mfaEnrolled: boolean;
}

export interface ResolvedActorServicePrincipal {
  kind: 'service_principal';
  id: string;
  tenantId: string;
  status: 'active' | 'revoked';
  maxAutonomy: AutonomyMode;
  grants: readonly ServicePrincipalGrant[];
}

export interface ResolvedActorExternalReviewer {
  kind: 'external_reviewer';
  id: string; // external_reviewer_link id
  tenantId: string;
  reviewRequestId: string;
  brandId: string;
  revoked: boolean;
  expired: boolean;
}

export interface ResolvedActorPlatformOperator {
  kind: 'platform_operator';
  id: string;
  tenantId: string;
  supportSessionId: string;
  mode: 'read_only' | 'escalated';
  expired: boolean;
}

export type ResolvedActor =
  | ResolvedActorUser
  | ResolvedActorServicePrincipal
  | ResolvedActorExternalReviewer
  | ResolvedActorPlatformOperator;

export interface PolicyResource {
  type: string;
  tenantId: string;
  id?: string;
  brandId?: string;
  channelId?: string;
  state?: string;
  /** For separation-of-duties checks: who authored the revision being decided on. */
  authorPrincipalId?: string;
  /** For external reviewers: the review request the resource belongs to. */
  reviewRequestId?: string;
}

export interface PolicyContext {
  autonomyMode?: AutonomyMode;
  entitlements: EntitlementSet;
  now: Date;
  /** Tenant policy: distinct approver required (D-11; default off). */
  requireDistinctApprover?: boolean;
  /** Tenant policy: MFA required for this tenant. */
  mfaRequired?: boolean;
}

export interface PolicyInput {
  actor: ResolvedActor;
  action: Action;
  resource: PolicyResource;
  context: PolicyContext;
}

export const MembershipRoleSchema = MembershipRole;
export { AutonomyMode };
