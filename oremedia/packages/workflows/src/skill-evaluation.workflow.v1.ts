import { proxyActivities } from '@temporalio/workflow';
import type {
  SkillEvaluationActivitiesV1,
  SkillEvaluationResultV1,
  SkillEvaluationWorkflowInputV1,
} from '@oremedia/contracts/skills';

/**
 * Spec 10.2 / 19.6: skills.versions.evaluate → skillEvaluationWorkflowV1 on task queue `agents` (workflow id
 * `skill-evaluation:<skillVersionId>:<suiteId>`). runSkillEvaluation runs the suite (≥ 3 model calls per case plus
 * the grader) with no transaction open and records the report through the skills module in one short transaction;
 * when it fails (retries exhausted or a non-retryable domain error) failSkillEvaluation returns the version to
 * draft so nothing stays in sandbox_evaluation, as renderJobWorkflowV1 does with failRender. Activities throw
 * ApplicationFailure.nonRetryable(message, 'PolicyDenied' | 'ValidationFailed' | 'NotFound'); nonRetryableErrorTypes
 * matches ApplicationFailure.type, not a JS class name. A retried activity finds the version already recorded and is
 * a no-op. Once deployed this file is immutable; changes ship as v2.
 */
export const NON_RETRYABLE_ERROR_TYPES = ['ValidationFailed', 'PolicyDenied', 'NotFound'];

function detailOf(err: unknown): string {
  let current: unknown = err;
  let last = '';
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { message?: string; cause?: unknown };
    if (typeof e.message === 'string' && e.message) last = e.message;
    current = e.cause;
  }
  return (last || 'evaluation failed').slice(0, 500);
}

/** The orchestration, separated from the activity proxies so it can be exercised with fakes. */
export async function runSkillEvaluation(
  acts: SkillEvaluationActivitiesV1,
  input: SkillEvaluationWorkflowInputV1,
): Promise<SkillEvaluationResultV1> {
  try {
    return await acts.runSkillEvaluation(input);
  } catch (err) {
    // Retries are exhausted (or the error was non-retryable): the version must not stay in sandbox_evaluation.
    // failSkillEvaluation is tolerant of a version that already left the sandbox (it records nothing then).
    const error = detailOf(err);
    await acts.failSkillEvaluation({ ...input, error });
    return { outcome: 'failed', skillVersionId: input.skillVersionId, error };
  }
}

export async function skillEvaluationWorkflowV1(
  input: SkillEvaluationWorkflowInputV1,
): Promise<SkillEvaluationResultV1> {
  // The suite: many bounded model calls, heartbeating while the runner is busy.
  const heavy = proxyActivities<SkillEvaluationActivitiesV1>({
    startToCloseTimeout: '30 minutes',
    heartbeatTimeout: '2 minutes',
    retry: {
      maximumAttempts: 2,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  const fast = proxyActivities<SkillEvaluationActivitiesV1>({
    startToCloseTimeout: '2 minutes',
    retry: {
      initialInterval: '2s',
      maximumInterval: '1 minute',
      maximumAttempts: 5,
      nonRetryableErrorTypes: NON_RETRYABLE_ERROR_TYPES,
    },
  });
  return runSkillEvaluation(
    { runSkillEvaluation: heavy.runSkillEvaluation, failSkillEvaluation: fast.failSkillEvaluation },
    input,
  );
}
