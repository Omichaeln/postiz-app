import { RenderJobInputV1 } from '@oremedia/contracts/render';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Task queue for isolated rendering (spec 4.4: worker-render hosts `render` and `media`). */
export const RENDER_TASK_QUEUE = 'render';

/**
 * Spec 11.5: creative.renders.request → renderJobWorkflowV1. The workflow id is stable per render job so a
 * redelivered event joins the running workflow; the outbox row is the dedupe authority (spec 14.2).
 */
export function registerCreativeOutboxRoutes(): void {
  registerOutboxRoute('creative.render_requested', (evt) => {
    const p = evt.payload;
    const input = RenderJobInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      renderJobId: p['renderJobId'],
    });
    return {
      workflowType: 'renderJobWorkflowV1',
      taskQueue: RENDER_TASK_QUEUE,
      workflowId: `render:${input.renderJobId}`,
      args: [input],
    };
  });
}
