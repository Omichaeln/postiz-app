import { proxyActivities } from '@temporalio/workflow';
import type {
  DeletionActivitiesV1,
  DeletionFinishResultV1,
  DeletionStepResultV1,
  DeletionWorkflowInputV1,
} from '@oremedia/contracts/operations';

/**
 * Spec 17.5 deletion fan-out (task queue `core`, workflow id `deletion:<deletionRequestId>`, started from the outbox
 * event operations.deletion_requested). beginDeletion moves the request to in_progress and lists the registered
 * subsystem handlers still pending; each handler runs as its own activity and records its completion with evidence
 * on the request, so a retried activity or a re-run request repeats nothing already done; finishDeletion completes
 * the request or leaves it waiting for the operator actions it names (Temporal visibility, logs, backups).
 * Activities throw ApplicationFailure.nonRetryable(message, 'PolicyDenied' | 'ValidationFailed' | 'NotFound').
 * Once deployed this file is immutable; changes ship as v2.
 */
export const NON_RETRYABLE_ERROR_TYPES = ['PolicyDenied', 'ValidationFailed', 'NotFound'];

export interface DeletionRequestOutcome {
  state: DeletionFinishResultV1['state'];
  steps: Array<Pick<DeletionStepResultV1, 'handler' | 'status'>>;
  operatorActions: string[];
}

/** The orchestration, separated from the activity proxies so it runs with fakes in unit tests. */
export async function runDeletionRequest(
  acts: DeletionActivitiesV1,
  input: DeletionWorkflowInputV1,
): Promise<DeletionRequestOutcome> {
  const plan = await acts.beginDeletion(input);
  const steps: DeletionRequestOutcome['steps'] = [];
  for (const handler of plan.pending) {
    const step = await acts.runDeletionHandler({ ...input, handler });
    steps.push({ handler: step.handler, status: step.status });
  }
  const finished = await acts.finishDeletion(input);
  return { state: finished.state, steps, operatorActions: finished.operatorActions };
}

export async function deletionRequestWorkflowV1(
  input: DeletionWorkflowInputV1,
): Promise<DeletionRequestOutcome> {
  const acts = proxyActivities<DeletionActivitiesV1>({
    // One subsystem per activity; a large tenant's purge is batched inside the activity.
    startToCloseTimeout: '30 minutes',
    heartbeatTimeout: '5 minutes',
    retry: {
      initialInterval: '10s',
      maximumInterval: '10 minutes',
      maximumAttempts: 10,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  return runDeletionRequest(acts, input);
}
