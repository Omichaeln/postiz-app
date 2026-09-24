import { PolicyDeniedError } from '@oremedia/contracts/errors';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { resolveTenantContext, type Principal, type ResolvedTenant } from '@oremedia/module-access';
import type { GrantLoader } from './tenant';

/**
 * Spec 5.2: an activity never trusts the tenant or permissions captured when the workflow started. The actor
 * reference carried in the input is re-resolved here against the current membership, brand grants or service
 * principal grants, through the same resolver the API uses.
 */
export function principalFor(input: TenantContextInput): Principal {
  switch (input.actor.kind) {
    case 'user':
      return {
        kind: 'user',
        userId: input.actor.id,
        sessionId: `activity:${input.correlationId}`,
        selectedTenantId: input.tenantId,
      };
    case 'service_principal':
      return {
        kind: 'api_client',
        apiClientId: `activity:${input.correlationId}`,
        servicePrincipalId: input.actor.id,
        tenantId: input.tenantId,
        scopes: [],
      };
    default:
      throw new PolicyDeniedError(
        'actor_kind_not_allowed_in_worker',
        `Actor kind ${input.actor.kind} cannot drive background work`,
      );
  }
}

export const resolveActivityActor = (input: TenantContextInput): Promise<ResolvedTenant> =>
  resolveTenantContext(principalFor(input), input.tenantId, input.correlationId);

/** The GrantLoader for inTenant: the actor's brand set as it is now, not as it was when the workflow started. */
export const loadActorGrants: GrantLoader = async (input) => ({
  brandIds: (await resolveActivityActor(input)).context.brandIds,
});
