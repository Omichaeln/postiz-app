import type { SkillEvaluationStore } from '@oremedia/activities';
import { skillsService } from '@oremedia/module-skills';

/**
 * The skills module's evaluation surface as the evaluation activity needs it (spec 10.2 / 19.6: the worker runs the
 * suite through the module's registered runner and the version moves only by the skill version state machine),
 * the same shape as apps/worker-render's creative store.
 */
export function skillEvaluationStore(): SkillEvaluationStore {
  return {
    runEvaluation: (input) => skillsService.versions.runEvaluation(input),
    recordEvaluation: (input, tx) => skillsService.versions.recordEvaluation(input, tx),
    async failEvaluation(input, tx) {
      await skillsService.versions.failEvaluation(input, tx);
    },
  };
}
