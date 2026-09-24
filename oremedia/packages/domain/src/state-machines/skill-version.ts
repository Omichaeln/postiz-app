import type { SkillVersionState } from '@oremedia/contracts/skills';
import { defineMachine } from './machine';

export type SkillVersionEvent =
  'start_evaluation' | 'evaluation_passed' | 'evaluation_failed' | 'reject' | 'publish' | 'retire';

/**
 * Spec 10.2: draft → sandbox_evaluation → in_review → published (rollout %) → retired.
 * A failed evaluation returns the version to draft from sandbox_evaluation (chosen over in_review → draft: the
 * failure is known before review opens, so nothing failing ever reaches a reviewer); a reviewer sends an in_review
 * version back to draft with `reject`. Rollback is not a transition: it is a binding to an earlier published
 * version and affects future runs only. Retired is final; an evaluation in flight cannot be retired.
 */
export const skillVersionMachine = defineMachine<SkillVersionState, SkillVersionEvent>({
  name: 'skill_version',
  states: ['draft', 'sandbox_evaluation', 'in_review', 'published', 'retired'],
  events: ['start_evaluation', 'evaluation_passed', 'evaluation_failed', 'reject', 'publish', 'retire'],
  table: {
    draft: { start_evaluation: 'sandbox_evaluation', retire: 'retired' },
    sandbox_evaluation: { evaluation_passed: 'in_review', evaluation_failed: 'draft' },
    in_review: { publish: 'published', reject: 'draft', retire: 'retired' },
    published: { retire: 'retired' },
    retired: {},
  },
  terminal: ['retired'],
});
