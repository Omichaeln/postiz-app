import { describe, expect, it } from 'vitest';
import type {
  SkillEvaluationActivitiesV1,
  SkillEvaluationResultV1,
  SkillEvaluationWorkflowInputV1,
} from '@oremedia/contracts/skills';
import { NON_RETRYABLE_ERROR_TYPES, runSkillEvaluation } from './skill-evaluation.workflow.v1';

const input: SkillEvaluationWorkflowInputV1 = {
  tenantId: 'ten_A',
  actor: { kind: 'user', id: 'usr_1' },
  correlationId: 'corr_eval',
  skillVersionId: 'skv_1',
  skillId: 'skl_1',
  suiteId: 'evs_1',
  runs: 3,
};

/** Fake activities: every call is recorded in order; the run answers with the given result or throws. */
function fakes(result: SkillEvaluationResultV1 | Error) {
  const calls: Array<{ name: string; input: unknown }> = [];
  const acts: SkillEvaluationActivitiesV1 = {
    runSkillEvaluation: async (arg) => {
      calls.push({ name: 'runSkillEvaluation', input: arg });
      if (result instanceof Error) throw result;
      return result;
    },
    failSkillEvaluation: async (arg) => {
      calls.push({ name: 'failSkillEvaluation', input: arg });
    },
  };
  return { acts, calls, names: () => calls.map((c) => c.name) };
}

const activityFailure = (type: string, message = type) =>
  Object.assign(new Error('activity failed'), {
    name: 'ActivityFailure',
    cause: Object.assign(new Error(message), { name: 'ApplicationFailure', type }),
  });

describe('skillEvaluationWorkflowV1 orchestration (spec 10.2, 19.6)', () => {
  it('runs the evaluation activity with the workflow input and returns its recorded result', async () => {
    const recorded: SkillEvaluationResultV1 = {
      outcome: 'recorded',
      skillVersionId: 'skv_1',
      suiteId: 'evs_1',
      resultId: 'evr_1',
      passed: true,
      state: 'in_review',
    };
    const f = fakes(recorded);
    expect(await runSkillEvaluation(f.acts, input)).toEqual(recorded);
    expect(f.calls).toEqual([{ name: 'runSkillEvaluation', input }]);
  });

  it('a version that already left the sandbox (re-delivered event, retried activity) is reported as skipped', async () => {
    const skipped: SkillEvaluationResultV1 = {
      outcome: 'skipped',
      skillVersionId: 'skv_1',
      state: 'in_review',
    };
    const f = fakes(skipped);
    expect(await runSkillEvaluation(f.acts, input)).toEqual(skipped);
    expect(f.names()).toEqual(['runSkillEvaluation']);
  });

  it('an exhausted run (model outage) fails the evaluation with the innermost message and ends as failed', async () => {
    const f = fakes(activityFailure('Error', 'model unavailable'));
    expect(await runSkillEvaluation(f.acts, input)).toEqual({
      outcome: 'failed',
      skillVersionId: 'skv_1',
      error: 'model unavailable',
    });
    expect(f.names()).toEqual(['runSkillEvaluation', 'failSkillEvaluation']);
    expect(f.calls[1]?.input).toEqual({ ...input, error: 'model unavailable' });
  });

  it('a non-retryable domain failure (lost permission) also returns the version to draft', async () => {
    const f = fakes(activityFailure('PolicyDenied', 'membership_inactive'));
    expect(await runSkillEvaluation(f.acts, input)).toMatchObject({ outcome: 'failed' });
    expect(f.calls[1]?.input).toMatchObject({ error: 'membership_inactive' });
    expect(NON_RETRYABLE_ERROR_TYPES).toEqual(['ValidationFailed', 'PolicyDenied', 'NotFound']);
  });
});
