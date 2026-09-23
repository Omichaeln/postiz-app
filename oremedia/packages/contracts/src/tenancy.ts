import { z } from 'zod';

export const ActorKind = z.enum(['user', 'service_principal', 'external_reviewer', 'platform_operator']);
export type ActorKind = z.infer<typeof ActorKind>;

export const ActorRef = z.object({ kind: ActorKind, id: z.string() });
export type ActorRef = z.infer<typeof ActorRef>;

export const AutonomyMode = z.enum(['assist', 'create', 'prepare_release', 'managed_autopublish']);
export type AutonomyMode = z.infer<typeof AutonomyMode>;

export const AUTONOMY_ORDER: readonly AutonomyMode[] = [
  'assist',
  'create',
  'prepare_release',
  'managed_autopublish',
];

export const MembershipRole = z.enum([
  'owner',
  'admin',
  'brand_manager',
  'creator',
  'reviewer',
  'publisher',
  'analyst',
  'community',
]);
export type MembershipRole = z.infer<typeof MembershipRole>;

/** Serialisable form of the tenant context carried into workers (spec 5.2). */
export const TenantContextInput = z.object({
  tenantId: z.string(),
  actor: ActorRef,
  correlationId: z.string(),
});
export type TenantContextInput = z.infer<typeof TenantContextInput>;
