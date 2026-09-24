import type { DeletionRuntimeV1, RetentionRuntimeV1 } from '@oremedia/contracts/operations';
import { requireTenant, withTransaction } from '@oremedia/db';
import { deletion } from './deletion';
import { retention } from './retention';

/**
 * The runtime behind deletionRequestWorkflowV1 and retentionSweepWorkflowV1 (spec 17.5, task queue `core`). The
 * activity host establishes the tenant context; each step is one transaction, so a handler's rows and its
 * fan-out entry commit together and a retried step finds its entry done.
 */
export function createOperationsRuntime(): { deletion: DeletionRuntimeV1; retention: RetentionRuntimeV1 } {
  const actor = () => requireTenant().actor;
  return {
    deletion: {
      beginDeletion: (input) => withTransaction((tx) => deletion.begin(actor(), input.deletionRequestId, tx)),
      runDeletionHandler: (input) =>
        withTransaction((tx) => deletion.runHandler(actor(), input.deletionRequestId, input.handler, tx)),
      finishDeletion: (input) =>
        withTransaction((tx) => deletion.finish(actor(), input.deletionRequestId, tx)),
    },
    retention: {
      listRetentionTenants: (input) => retention.tenants(input.correlationId),
      applyRetention: async (input) => ({
        tenantId: input.tenantId,
        dryRun: input.dryRun,
        classes: await withTransaction((tx) =>
          retention.apply(actor(), new Date(input.now), input.dryRun, tx),
        ),
      }),
    },
  };
}
