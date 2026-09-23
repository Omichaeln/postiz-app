import { Context } from '@temporalio/activity';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { runInTenant, type TenantContext } from '@oremedia/db';
import { withLogContext } from '@oremedia/observability';

/**
 * Spec 5.2: workers do not inherit HTTP context. Every activity input carries tenantId and actorRef, and the
 * activity wraps its body in runInTenant after re-loading the actor's current grants at the point of effect.
 */
export interface ActivityActorGrants {
  brandIds: ReadonlySet<string> | 'all';
}

export type GrantLoader = (input: TenantContextInput) => Promise<ActivityActorGrants>;

export function inTenant<T>(
  input: TenantContextInput,
  loadGrants: GrantLoader,
  fn: () => Promise<T>,
): Promise<T> {
  return withLogContext({ correlationId: input.correlationId, tenantId: input.tenantId }, async () => {
    const grants = await loadGrants(input);
    const ctx: TenantContext = {
      tenantId: input.tenantId,
      actor: input.actor,
      brandIds: grants.brandIds,
      correlationId: input.correlationId,
    };
    return runInTenant(ctx, fn);
  });
}

/** Heartbeat details live on the per-activity context, never on a shared singleton (spec 20.3). */
export function heartbeat(detail: string): void {
  try {
    Context.current().heartbeat(detail);
  } catch {
    // Outside a Temporal activity (unit tests, scripts): no-op.
  }
}
