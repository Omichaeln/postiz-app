import { PolicyDeniedError } from '@oremedia/contracts/errors';
import type {
  Action,
  Decision,
  EntitlementSet,
  PolicyContext,
  PolicyResource,
  ResolvedActor,
} from '@oremedia/contracts/policy';
import { ENTITLEMENT_GATED_ACTIONS, authorize } from '@oremedia/domain/policy';
import { count, METRIC } from '@oremedia/observability';
import { audit } from '@oremedia/module-operations';
import { entitlements } from '@oremedia/module-billing';
import type { Tx } from '@oremedia/db';

export interface PolicyOptions {
  autonomyMode?: PolicyContext['autonomyMode'];
  requireDistinctApprover?: boolean;
  mfaRequired?: boolean;
  now?: Date;
}

/** Never consulted: `authorize` reads entitlements only for ENTITLEMENT_GATED_ACTIONS (spec 5.5 step 6). */
const NO_ENTITLEMENTS: EntitlementSet = { limits: {}, features: {}, usage: {} };

/**
 * The single authorisation entry point used by routers, activities and the tool dispatcher. Loads entitlements
 * for the gated actions only (a subscription join plus usage counts is too much for every read), runs the pure
 * decision, records the audit event (allowed or denied) and throws FORBIDDEN on denial.
 */
export async function decide(
  actor: ResolvedActor,
  action: Action,
  resource: PolicyResource,
  opts: PolicyOptions = {},
  tx?: Tx,
): Promise<Decision> {
  const ent = ENTITLEMENT_GATED_ACTIONS.has(action)
    ? await entitlements.resolve(actor.tenantId, tx)
    : NO_ENTITLEMENTS;
  const decision = authorize({
    actor,
    action,
    resource,
    context: {
      autonomyMode: opts.autonomyMode,
      entitlements: ent,
      now: opts.now ?? new Date(),
      requireDistinctApprover: opts.requireDistinctApprover,
      mfaRequired: opts.mfaRequired,
    },
  });
  // Allowed decisions are audited with the command (same transaction); denials are audited on their own
  // connection so they survive the rollback that follows a PolicyDeniedError.
  await audit.record(
    { kind: actor.kind, id: actor.id },
    action,
    { type: resource.type, id: resource.id ?? resource.brandId ?? resource.tenantId },
    decision,
    decision.allowed ? tx : undefined,
    resource.brandId ? { brandId: resource.brandId } : undefined,
  );
  if (!decision.allowed) count(METRIC.policyDenials, 1, { reason: decision.reason, action });
  return decision;
}

export async function assert(
  actor: ResolvedActor,
  action: Action,
  resource: PolicyResource,
  opts: PolicyOptions = {},
  tx?: Tx,
): Promise<Decision> {
  const d = await decide(actor, action, resource, opts, tx);
  if (!d.allowed) throw new PolicyDeniedError(d.reason);
  return d;
}

/** Spec 13.4 approver_still_authorised / owner_still_authorised: a fresh read, never a cached decision. */
export async function stillHas(
  actor: ResolvedActor,
  action: Action,
  brandId: string,
  tx?: Tx,
): Promise<boolean> {
  const d = await decide(actor, action, { type: 'brand', tenantId: actor.tenantId, brandId }, {}, tx);
  return d.allowed;
}

export const policy = { decide, assert, stillHas };
