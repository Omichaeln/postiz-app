import { ScheduleAlreadyRunning, ScheduleOverlapPolicy, type Client } from '@temporalio/client';
import { createDeletionActivities, createRetentionActivities } from '@oremedia/activities';
import {
  OPERATIONS_TASK_QUEUE,
  RETENTION_SCHEDULE_ID,
  RETENTION_SWEEP_WORKFLOW_TYPE,
  createOperationsRuntime,
} from '@oremedia/module-operations';
import { runWithDatabaseRole } from '@oremedia/db';
import { logger } from '@oremedia/observability';

/**
 * Spec 17.5: deletionRequestWorkflowV1 and retentionSweepWorkflowV1 run on task queue `core` (this worker); their
 * activities join the core worker (publishing-worker.ts). The retention sweep is a daily Temporal schedule created
 * once per namespace. It runs as a dry run (counts only) unless RETENTION_SWEEP_APPLY=true when the schedule is
 * first created: the retention periods are still to be confirmed (D-09). Changing the mode later means updating
 * the schedule's action (docs/runbooks/process-deletion-request.md).
 */
export function operationsActivities() {
  const runtime = createOperationsRuntime();
  return {
    ...createDeletionActivities(runtime.deletion),
    // Spec 17.5 / 6.1: the TTL deletes run on the retention role's connection (DATABASE_URL_RETENTION,
    // roles/retention-role.sql), the only role with DELETE on the insert-only tables a TTL class removes.
    ...createRetentionActivities({
      listRetentionTenants: (input) => runtime.retention.listRetentionTenants(input),
      applyRetention: (input) =>
        runWithDatabaseRole('retention', () => runtime.retention.applyRetention(input)),
    }),
  };
}

/** Daily at 02:30 UTC, outside the top-of-hour publishing burst. */
export const RETENTION_CALENDAR = { hour: 2, minute: 30 } as const;

export async function ensureRetentionScheduleRunning(
  client: Client,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dryRun = env['RETENTION_SWEEP_APPLY'] !== 'true';
  try {
    await client.schedule.create({
      scheduleId: RETENTION_SCHEDULE_ID,
      spec: { calendars: [{ ...RETENTION_CALENDAR }] },
      action: {
        type: 'startWorkflow',
        workflowType: RETENTION_SWEEP_WORKFLOW_TYPE,
        taskQueue: OPERATIONS_TASK_QUEUE,
        args: [{ dryRun }],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '1 day' },
    });
    logger().info({ status: `${RETENTION_SCHEDULE_ID}:${dryRun ? 'dry_run' : 'apply'}` }, 'schedule created');
  } catch (err) {
    if (err instanceof ScheduleAlreadyRunning) return; // one per namespace; joined
    throw err;
  }
}
