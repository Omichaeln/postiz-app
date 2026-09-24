import type { Action, Decision, Obligation, PolicyInput, ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { AGENT_NEVER, AGENT_PROPOSE_ONLY, DEFAULT_ROLE_GRANTS, OPERATOR_READ_ONLY } from './role-grants';
import { autonomyAtLeast } from './autonomy';

/**
 * Spec 5.5: one auditable function decides. Everything calls it.
 * Order matters and is tested:
 *   1. tenant match   2. membership active   3. brand grant   4. role/permission
 *   5. resource state 6. entitlement 7. service-principal grant ∩ autonomy mode 8. obligations
 */
const deny = (reason: string): Decision => ({ allowed: false, reason });
const allow = (obligations?: Obligation[]): Decision =>
  obligations && obligations.length
    ? { allowed: true, reason: 'ok', obligations }
    : { allowed: true, reason: 'ok' };

/** Resource states in which an action is not permitted (step 5). */
const STATE_DENIALS: Partial<Record<Action, readonly string[]>> = {
  'creative.edit': ['approved', 'superseded'],
  'content.edit': ['approved', 'superseded', 'in_review'],
  'brand.edit_standards': ['published', 'retired'],
  'review.decide': ['stale', 'decided', 'cancelled'],
  'publication.cancel': ['published', 'failed', 'cancelled'],
  'asset.approve': ['retired'],
  'agent.cancel_run': [
    'completed',
    'failed',
    'cancelled',
    'budget_exhausted',
    'policy_denied',
    'waiting_expired',
  ],
};

/** Entitlement gates per action (step 6). */
type EntitlementGate =
  | {
      kind: 'limit';
      feature:
        'brands' | 'seats' | 'channels' | 'generation_budget_micros_month' | 'experiments' | 'inbox_seats';
    }
  | { kind: 'feature'; feature: 'experiments' | 'managed_autopublish' };
const ENTITLEMENT_GATES: Partial<Record<Action, EntitlementGate>> = {
  'channel.connect': { kind: 'limit', feature: 'channels' },
  'membership.manage': { kind: 'limit', feature: 'seats' },
  'agent.start_run': { kind: 'limit', feature: 'generation_budget_micros_month' },
  'experiment.manage': { kind: 'feature', feature: 'experiments' },
  'mandate.manage': { kind: 'feature', feature: 'managed_autopublish' },
};

/** The actions whose decision consults entitlements; callers resolve entitlements only for these. */
export const ENTITLEMENT_GATED_ACTIONS: ReadonlySet<Action> = new Set(
  Object.keys(ENTITLEMENT_GATES) as Action[],
);

/** Minimum autonomy mode an agent needs for an action (step 7). */
const AUTONOMY_FOR_ACTION: Partial<Record<Action, AutonomyMode>> = {
  'brand.read': 'assist',
  'asset.read': 'assist',
  'creative.read': 'assist',
  'insight.read': 'assist',
  'skill.read': 'assist',
  'content.plan': 'create',
  'content.edit': 'create',
  'creative.edit': 'create',
  'creative.render': 'create',
  'asset.upload': 'create',
  'agent.start_run': 'create',
  'agent.cancel_run': 'create',
  'experiment.manage': 'create',
  'insight.manage': 'create',
  'inbox.respond': 'create',
  'brand.edit_standards': 'create',
  'brand.publish_version': 'create',
  'skill.author': 'create',
  'review.request': 'prepare_release',
  'publication.schedule': 'prepare_release',
  'publication.cancel': 'prepare_release',
};

function actorMayTouchBrand(actor: ResolvedActor, brandId: string, action: Action): boolean {
  switch (actor.kind) {
    case 'user':
      return actor.allBrands || actor.brandGrants.some((g) => g.brandId === brandId);
    case 'service_principal':
      return actor.grants.some(
        (g) => g.action === action && (g.brandIds === 'all' || g.brandIds.includes(brandId)),
      );
    case 'external_reviewer':
      return actor.brandId === brandId;
    case 'platform_operator':
      return true;
  }
}

function userHasRoleFor(
  actor: Extract<ResolvedActor, { kind: 'user' }>,
  action: Action,
  brandId: string | undefined,
): boolean {
  const roles = new Set<string>([actor.role]);
  if (brandId) {
    for (const g of actor.brandGrants) if (g.brandId === brandId) for (const r of g.roles) roles.add(r);
  }
  const allowed = DEFAULT_ROLE_GRANTS[action];
  return allowed.some((r) => roles.has(r));
}

export function authorize(input: PolicyInput): Decision {
  const { actor, action, resource, context } = input;

  // 1. tenant match
  if (resource.tenantId !== actor.tenantId) return deny('tenant_mismatch');

  // 2. membership / principal active
  switch (actor.kind) {
    case 'user':
      if (actor.membershipStatus !== 'active') return deny('membership_inactive');
      if (context.mfaRequired && !actor.mfaEnrolled) return deny('mfa_required');
      break;
    case 'service_principal':
      if (actor.status !== 'active') return deny('principal_revoked');
      break;
    case 'external_reviewer':
      if (actor.revoked) return deny('reviewer_link_revoked');
      if (actor.expired) return deny('reviewer_link_expired');
      break;
    case 'platform_operator':
      if (actor.expired) return deny('support_session_expired');
      break;
  }

  // 3. brand grant
  if (resource.brandId !== undefined && !actorMayTouchBrand(actor, resource.brandId, action))
    return deny('brand_not_granted');

  // 4. role / permission
  switch (actor.kind) {
    case 'user':
      if (!userHasRoleFor(actor, action, resource.brandId)) return deny('role_missing');
      break;
    case 'service_principal':
      if (AGENT_NEVER.has(action)) return deny('agent_never');
      if (!actor.grants.some((g) => g.action === action)) return deny('grant_missing');
      if (resource.channelId !== undefined) {
        const ok = actor.grants.some(
          (g) =>
            g.action === action &&
            (g.channelConnectionIds === undefined ||
              g.channelConnectionIds === 'all' ||
              g.channelConnectionIds.includes(resource.channelId as string)),
        );
        if (!ok) return deny('channel_not_granted');
      }
      break;
    case 'external_reviewer':
      if (action !== 'review.decide') return deny('reviewer_scope');
      if (resource.reviewRequestId !== actor.reviewRequestId) return deny('reviewer_wrong_request');
      break;
    case 'platform_operator':
      if (!OPERATOR_READ_ONLY.has(action) && actor.mode !== 'escalated') return deny('support_read_only');
      if (
        [
          'review.decide',
          'publication.schedule',
          'publication.delete_remote',
          'billing.manage',
          'channel.connect',
        ].includes(action)
      )
        return deny('support_never');
      break;
  }

  // 5. resource state
  const denied = STATE_DENIALS[action];
  if (denied && resource.state !== undefined && denied.includes(resource.state))
    return deny('resource_state');

  // 6. entitlement
  const gate = ENTITLEMENT_GATES[action];
  if (gate) {
    if (gate.kind === 'feature') {
      if (!context.entitlements.features[gate.feature]) return deny('entitlement_exceeded');
    } else {
      const limit = context.entitlements.limits[gate.feature];
      const usage = context.entitlements.usage[gate.feature] ?? 0;
      if (limit === undefined) return deny('entitlement_exceeded');
      if (usage >= limit) return deny('entitlement_exceeded');
    }
  }

  // 7. service-principal grant ∩ autonomy mode
  const obligations: Obligation[] = [];
  if (actor.kind === 'service_principal') {
    // An explicit mode (an agent run's) wins; a direct API call carries its per-request ceiling; otherwise the lowest.
    const mode = context.autonomyMode ?? actor.requestAutonomy ?? 'assist';
    if (!autonomyAtLeast(actor.maxAutonomy, mode)) return deny('autonomy_exceeds_principal');
    const required = AUTONOMY_FOR_ACTION[action];
    if (required === undefined) return deny('agent_never');
    if (!autonomyAtLeast(mode, required)) return deny('autonomy_insufficient');
    if (AGENT_PROPOSE_ONLY.has(action)) obligations.push({ type: 'propose_only' });
    if (action === 'publication.schedule' && mode !== 'managed_autopublish')
      obligations.push({ type: 'requires_approval', scope: 'publication' });
  }

  // 8. obligations: separation of duties
  if (
    action === 'review.decide' &&
    context.requireDistinctApprover &&
    resource.authorPrincipalId !== undefined &&
    resource.authorPrincipalId === actor.id
  ) {
    return deny('distinct_approver_required');
  }

  return allow(obligations);
}
