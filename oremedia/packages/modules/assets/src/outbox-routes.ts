import { AssetIngestInputV1 } from '@oremedia/contracts/assets';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Task queue for untrusted-input parsing (spec 4.4: worker-render hosts `render` and `media`). */
export const MEDIA_TASK_QUEUE = 'media';

/**
 * Spec 9.1: complete(intentId) → assetIngestWorkflowV1. The outbox row is the dedupe authority; the workflow id is
 * stable per upload intent so a redelivered event joins the running workflow instead of starting a second one.
 */
export function registerAssetOutboxRoutes(): void {
  registerOutboxRoute('asset.upload_completed', (evt) => {
    const p = evt.payload;
    const input = AssetIngestInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      intentId: p['uploadIntentId'],
      brandId: p['brandId'],
    });
    return {
      workflowType: 'assetIngestWorkflowV1',
      taskQueue: MEDIA_TASK_QUEUE,
      workflowId: `ingest:${input.intentId}`,
      args: [input],
    };
  });
}
