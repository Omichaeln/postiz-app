import type {
  DeletionActivitiesV1,
  DeletionRuntimeV1,
  RetentionActivitiesV1,
  RetentionRuntimeV1,
} from '@oremedia/contracts/operations';
import type { TenantContextInput } from '@oremedia/contracts/tenancy';
import { withLogContext } from '@oremedia/observability';
import { toActivityFailure } from './agent-run';
import { heartbeat, inTenant, type GrantLoader } from './tenant';

/**
 * The authority for a deletion step is the deletion request row itself: it was authorised (billing.manage) and
 * audited when it was made, and the runtime reads it by id under the input's tenant scope, so an input naming
 * another tenant's request finds nothing. The requester's own membership may be one of the rows a tenant
 * deletion removes, so the requester's grants are not re-loaded here (spec 5.2's re-check is the request row).
 */
const requestAuthority: GrantLoader = async () => ({ brandIds: 'all' });

/** Retention is a platform job applied inside each tenant: no requesting actor, every brand of the tenant. */
export const RETENTION_ACTOR = { kind: 'platform_operator' as const, id: 'retention-sweep' };
const wholeTenant: GrantLoader = async () => ({ brandIds: 'all' });

/**
 * Spec 17.5 activities for deletionRequestWorkflowV1 and retentionSweepWorkflowV1 (task queue `core`): tenant
 * context from the input and domain errors translated into the workflows' failure types. Every effect lives in the
 * operations module's runtime (createOperationsRuntime) and the handlers the modules registered.
 */
export function createDeletionActivities(runtime: DeletionRuntimeV1): DeletionActivitiesV1 {
  const guarded =
    <I extends TenantContextInput, R>(fn: (input: I) => Promise<R>) =>
    async (input: I): Promise<R> => {
      try {
        return await inTenant(input, requestAuthority, () => fn(input));
      } catch (err) {
        throw toActivityFailure(err);
      }
    };
  return {
    beginDeletion: guarded((input) => runtime.beginDeletion(input)),
    runDeletionHandler: guarded((input) => {
      heartbeat(`deletion:${input.deletionRequestId}:${input.handler}`);
      return runtime.runDeletionHandler(input);
    }),
    finishDeletion: guarded((input) => runtime.finishDeletion(input)),
  };
}

export function createRetentionActivities(runtime: RetentionRuntimeV1): RetentionActivitiesV1 {
  return {
    listRetentionTenants: (input) =>
      withLogContext({ correlationId: input.correlationId }, () => runtime.listRetentionTenants(input)),
    applyRetention: async (input) => {
      try {
        return await inTenant(
          { tenantId: input.tenantId, actor: RETENTION_ACTOR, correlationId: input.correlationId },
          wholeTenant,
          () => {
            heartbeat(`retention:${input.tenantId}`);
            return runtime.applyRetention(input);
          },
        );
      } catch (err) {
        throw toActivityFailure(err);
      }
    },
  };
}
