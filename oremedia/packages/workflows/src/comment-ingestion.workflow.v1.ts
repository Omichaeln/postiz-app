import { proxyActivities, sleep } from '@temporalio/workflow';
import type {
  CommentIngestionActivitiesV1,
  CommentIngestionWorkflowInputV1,
} from '@oremedia/contracts/measurement';

/**
 * Spec 16.5 (read-only half): one ingestion per publication (workflow id `comments:<publicationId>`, task queue
 * `ingest-comments`). Comments arrive early and tail off, so the pulls sit at +1 h, +6 h, +24 h, +72 h, +7 d,
 * +14 d and +28 d; each pull pages through the adapter's cursor until it is exhausted (bounded). Since-marks come
 * from what is already stored, so a repeat pull ingests nothing twice. Once deployed this file is immutable.
 */
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const COMMENT_PULL_OFFSETS_MS = [
  1 * HOUR_MS,
  6 * HOUR_MS,
  24 * HOUR_MS,
  72 * HOUR_MS,
  7 * DAY_MS,
  14 * DAY_MS,
  28 * DAY_MS,
] as const;
/** A page loop cannot run away on a platform that always returns a cursor. */
export const MAX_PAGES_PER_PULL = 50;

export interface CommentIngestionHost {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CommentIngestionOutcome {
  outcome: 'ingested' | 'not_collectable' | 'comments_not_readable';
  pulls: number;
  ingested: number;
  failed: number;
}

export async function runCommentIngestion(
  acts: CommentIngestionActivitiesV1,
  input: CommentIngestionWorkflowInputV1,
  host: CommentIngestionHost,
): Promise<CommentIngestionOutcome> {
  const plan = await acts.readCollectionPlan(input);
  if (!plan.collectable || !plan.publishedAt)
    return { outcome: 'not_collectable', pulls: 0, ingested: 0, failed: 0 };
  if (!plan.commentsReadable) return { outcome: 'comments_not_readable', pulls: 0, ingested: 0, failed: 0 };
  const publishedAt = Date.parse(plan.publishedAt);
  let pulls = 0;
  let ingested = 0;
  let failed = 0;
  for (const [pullIndex, offset] of COMMENT_PULL_OFFSETS_MS.entries()) {
    const due = publishedAt + offset;
    const wait = due - host.now();
    if (wait > 0) await host.sleep(wait);
    let cursor: string | null = null;
    try {
      for (let page = 0; page < MAX_PAGES_PER_PULL; page++) {
        const result = await acts.pullComments({ ...input, pullIndex, since: null, cursor });
        ingested += result.ingested;
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      pulls += 1;
    } catch {
      failed += 1;
    }
  }
  return { outcome: 'ingested', pulls, ingested, failed };
}

export async function commentIngestionWorkflowV1(
  input: CommentIngestionWorkflowInputV1,
): Promise<CommentIngestionOutcome> {
  const acts = proxyActivities<CommentIngestionActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    heartbeatTimeout: '2 minutes',
    retry: { maximumAttempts: 3, nonRetryableErrorTypes: ['PolicyDenied', 'ValidationFailed'] },
  });
  return runCommentIngestion(acts, input, { now: () => Date.now(), sleep: (ms) => sleep(ms) });
}
