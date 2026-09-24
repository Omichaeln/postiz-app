import { SkillEvaluationWorkflowInputV1 } from '@oremedia/contracts/skills';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Spec 4.4: sandbox evaluations are authority-bearing model work and run on worker-core's `agents` task queue. */
export const SKILL_EVALUATION_TASK_QUEUE = 'agents';
export const SKILL_EVALUATION_WORKFLOW_TYPE = 'skillEvaluationWorkflowV1';

export const skillEvaluationWorkflowId = (skillVersionId: string, suiteId: string): string =>
  `skill-evaluation:${skillVersionId}:${suiteId}`;

/**
 * Spec 10.2 / 19.6: skills.versions.evaluate → skillEvaluationWorkflowV1. The workflow id is stable per version and
 * suite so a redelivered event joins the running workflow; the outbox row is the dedupe authority (spec 14.2).
 */
export function registerSkillOutboxRoutes(): void {
  registerOutboxRoute('skill.evaluation_requested', (evt) => {
    const p = evt.payload;
    const input = SkillEvaluationWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      skillVersionId: p['skillVersionId'],
      skillId: p['skillId'],
      suiteId: p['suiteId'],
      runs: p['runs'],
      ...(p['brandId'] ? { brandId: p['brandId'] } : {}),
    });
    return {
      workflowType: SKILL_EVALUATION_WORKFLOW_TYPE,
      taskQueue: SKILL_EVALUATION_TASK_QUEUE,
      workflowId: skillEvaluationWorkflowId(input.skillVersionId, input.suiteId),
      args: [input],
    };
  });
}
