import {
  dispatchToolDetailed,
  entitlementAutonomy,
  tenantPolicyFor,
  type AgentRunContext,
  type DispatchDeps,
  type DispatchOutcome,
} from '@oremedia/ai';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import type { TenantContext } from '@oremedia/db';
import { effectiveAutonomy } from '@oremedia/domain/autonomy';
import { newId } from '@oremedia/domain/ids';
import { entitlements } from '@oremedia/module-billing';

export interface SurfaceToolCall {
  tenantContext: TenantContext;
  /** The calling service principal as resolved for this request (grants, status, max autonomy). */
  principal: ResolvedActorServicePrincipal;
  /** The brand the call acts in ('' for a tenant-wide tool such as brands.list). */
  brandId: string;
  correlationId: string;
  /** The surface's allowlist: a registered tool outside it is denied as tool_not_allowed and audited. */
  allowedTools: readonly string[];
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Spec 7.6 / 12.4: a tool call a service principal makes from an external surface (the MCP server) outside a durable
 * run. It is given the AgentRunContext a run step would get (tenant context, principal, autonomy = min(principal,
 * tenant policy, entitlement) per spec 12.5, the surface allowlist) and goes through the same dispatcher, so policy,
 * audit, budgets and timeouts are identical to internal agents. There is no run: the call id (`mcp_...`) stands in
 * for the run and step ids in the audit trail, no budget is reserved (a costed tool is denied), no snapshot is pinned.
 */
/**
 * Spec 12.5 for a call with no run (public REST, tRPC with an API key, MCP): min(principal max, tenant policy,
 * entitlement). The principal's own ceiling stands in for "requested", so a key never exceeds what it was granted.
 */
export async function surfaceAutonomyFor(
  principal: Pick<ResolvedActorServicePrincipal, 'maxAutonomy'>,
  tenantId: string,
  correlationId: string,
): Promise<AutonomyMode> {
  const [tenantPolicy, ent] = await Promise.all([
    tenantPolicyFor(tenantId, correlationId),
    entitlements.resolve(tenantId),
  ]);
  return effectiveAutonomy(
    principal.maxAutonomy,
    principal.maxAutonomy,
    tenantPolicy.maxAutonomy,
    entitlementAutonomy(ent),
  );
}

export async function dispatchSurfaceToolCall(
  input: SurfaceToolCall,
  deps: DispatchDeps,
): Promise<DispatchOutcome & { callId: string }> {
  const tenantId = input.tenantContext.tenantId;
  const autonomyMode = await surfaceAutonomyFor(input.principal, tenantId, input.correlationId);
  const callId = newId('mcpCall');
  const run: AgentRunContext = {
    runId: callId,
    stepId: callId,
    tenantId,
    brandId: input.brandId,
    correlationId: input.correlationId,
    tenantContext: input.tenantContext,
    principal: input.principal,
    policy: {
      autonomyMode,
      allowedTools: [...input.allowedTools],
    },
    budgetReservationId: null,
    snapshot: null,
  };
  const outcome = await dispatchToolDetailed(
    { id: callId, name: input.name, arguments: input.arguments },
    run,
    deps,
  );
  return { ...outcome, callId };
}
