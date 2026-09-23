import { AUTONOMY_ORDER, type AutonomyMode } from '@oremedia/contracts/tenancy';

const rank = (m: AutonomyMode): number => AUTONOMY_ORDER.indexOf(m);

/** Spec 12.5: a run's mode is min(requested, principal.maxAutonomy, tenant policy, entitlement). */
export function effectiveAutonomy(
  requested: AutonomyMode,
  principalMax: AutonomyMode,
  tenantPolicyMax: AutonomyMode,
  entitlementMax: AutonomyMode,
): AutonomyMode {
  const candidates: AutonomyMode[] = [requested, principalMax, tenantPolicyMax, entitlementMax];
  return candidates.reduce((min, m) => (rank(m) < rank(min) ? m : min));
}

export const autonomyAtLeast = (mode: AutonomyMode, required: AutonomyMode): boolean =>
  rank(mode) >= rank(required);
