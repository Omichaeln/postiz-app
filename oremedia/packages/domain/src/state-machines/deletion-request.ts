import type { z } from 'zod';
import type { DeletionRequestState as DeletionRequestStateSchema } from '@oremedia/contracts/operations';
import { defineMachine } from './machine';

type DeletionRequestState = z.infer<typeof DeletionRequestStateSchema>;
export type DeletionRequestEvent = 'begin' | 'await_operator' | 'complete' | 'resume' | 'reapply';

/**
 * Spec 17.5 deletion requests: the fan-out begins, then either completes (every store done or not applicable) or
 * waits for an operator (stores without an API from here: Temporal visibility, logs, backups). A re-run of a
 * waiting request resumes it; each operator confirmation can complete it. After a restore (spec 17.6, restore
 * runbook step 6) a finished or waiting request is re-applied: its automated steps run again. Nothing else leaves
 * completed.
 */
export const deletionRequestMachine = defineMachine<DeletionRequestState, DeletionRequestEvent>({
  name: 'deletion_request',
  states: ['requested', 'in_progress', 'blocked', 'completed'],
  events: ['begin', 'await_operator', 'complete', 'resume', 'reapply'],
  table: {
    requested: { begin: 'in_progress' },
    in_progress: { await_operator: 'blocked', complete: 'completed' },
    blocked: { resume: 'in_progress', complete: 'completed', reapply: 'in_progress' },
    completed: { reapply: 'in_progress' },
  },
});
