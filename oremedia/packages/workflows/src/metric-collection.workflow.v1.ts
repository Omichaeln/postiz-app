import { ParentClosePolicy, proxyActivities, sleep, startChild } from '@temporalio/workflow';
import type {
  MetricCollectionActivitiesV1,
  MetricCollectionWorkflowInputV1,
} from '@oremedia/contracts/measurement';
import { commentIngestionWorkflowV1 } from './comment-ingestion.workflow.v1';

/**
 * Spec 15.1: one collection per published publication (workflow id `metrics:<publicationId>`, task queue
 * `ingest-metrics`). Pulls at +1 h, +24 h, +72 h, +7 d and +28 d after publication, then weekly to the 90-day
 * horizon, each no earlier than the capability's analytics latency; every pull is an activity that writes raw
 * snapshots idempotently per (publication, metric, window). When the capability can read comments, the comment
 * ingestion runs as an abandoned child on its own queue. Once deployed this file is immutable; changes ship as v2.
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const BASE_PULL_OFFSETS_MS = [
  1 * HOUR_MS,
  24 * HOUR_MS,
  72 * HOUR_MS,
  7 * DAY_MS,
  28 * DAY_MS,
] as const;
export const WEEKLY_MS = 7 * DAY_MS;
export const HORIZON_MS = 90 * DAY_MS;
/** Task queue of the child (spec 4.4); a literal because workflow code imports contracts only. */
export const INGEST_COMMENTS_TASK_QUEUE = 'ingest-comments';

/**
 * Offsets from the publication moment: the base pulls, weekly after +28 d while inside the horizon, and a closing
 * pull at the horizon itself. Each is pushed to the latency when the platform reports later than the offset; pulls
 * that collapse onto the same moment are made once.
 */
export function collectionSchedule(latencyHours: number): number[] {
  const offsets: number[] = [...BASE_PULL_OFFSETS_MS];
  for (let t = 28 * DAY_MS + WEEKLY_MS; t < HORIZON_MS; t += WEEKLY_MS) offsets.push(t);
  offsets.push(HORIZON_MS);
  const latencyMs = Math.max(0, latencyHours) * HOUR_MS;
  const out: number[] = [];
  for (const o of offsets) {
    const at = Math.max(o, latencyMs);
    if (!out.includes(at)) out.push(at);
  }
  return out;
}

export interface MetricCollectionHost {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Starts (or joins) the comment ingestion for the same publication on `ingest-comments`. */
  startCommentIngestion(input: MetricCollectionWorkflowInputV1): Promise<void>;
}

export interface MetricCollectionOutcome {
  outcome: 'collected' | 'not_collectable';
  pulls: number;
  failed: number;
  commentsStarted: boolean;
}

/** The orchestration with the durable waits behind a host, so unit tests assert the exact schedule with fakes. */
export async function runMetricCollection(
  acts: MetricCollectionActivitiesV1,
  input: MetricCollectionWorkflowInputV1,
  host: MetricCollectionHost,
): Promise<MetricCollectionOutcome> {
  const plan = await acts.readCollectionPlan(input);
  if (!plan.collectable || !plan.publishedAt)
    return { outcome: 'not_collectable', pulls: 0, failed: 0, commentsStarted: false };
  let commentsStarted = false;
  if (plan.commentsReadable) {
    await host.startCommentIngestion(input);
    commentsStarted = true;
  }
  const publishedAt = Date.parse(plan.publishedAt);
  let pulls = 0;
  let failed = 0;
  const schedule = collectionSchedule(plan.latencyHours);
  for (const [pullIndex, offset] of schedule.entries()) {
    const due = publishedAt + offset;
    const wait = due - host.now();
    if (wait > 0) await host.sleep(wait);
    try {
      await acts.pullMetrics({
        ...input,
        pullIndex,
        windowStart: new Date(publishedAt).toISOString(),
        windowEnd: new Date(due).toISOString(),
      });
      pulls += 1;
    } catch {
      failed += 1; // the activity host retried transient failures; a permanent one must not end the schedule
    }
  }
  return { outcome: 'collected', pulls, failed, commentsStarted };
}

export async function metricCollectionWorkflowV1(
  input: MetricCollectionWorkflowInputV1,
): Promise<MetricCollectionOutcome> {
  const acts = proxyActivities<MetricCollectionActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    heartbeatTimeout: '2 minutes',
    retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['PolicyDenied', 'ValidationFailed'] },
  });
  return runMetricCollection(acts, input, {
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
    startCommentIngestion: async (i) => {
      try {
        await startChild(commentIngestionWorkflowV1, {
          taskQueue: INGEST_COMMENTS_TASK_QUEUE,
          workflowId: `comments:${i.publicationId}`,
          args: [i],
          parentClosePolicy: ParentClosePolicy.ABANDON,
        });
      } catch (err) {
        // Already running from an earlier delivery: joining is the intent of the stable id.
        if ((err as { name?: string }).name !== 'WorkflowExecutionAlreadyStartedError') throw err;
      }
    },
  });
}
