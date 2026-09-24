import { MetricCollectionWorkflowInputV1 } from '@oremedia/contracts/measurement';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Spec 4.4: worker-ingest hosts `ingest-metrics` and `ingest-comments`, so scheduled pulls never starve publishing. */
export const INGEST_METRICS_TASK_QUEUE = 'ingest-metrics';
export const INGEST_COMMENTS_TASK_QUEUE = 'ingest-comments';
export const METRIC_COLLECTION_WORKFLOW_TYPE = 'metricCollectionWorkflowV1';
export const COMMENT_INGESTION_WORKFLOW_TYPE = 'commentIngestionWorkflowV1';

/** Stable ids: one collection and one ingestion per publication; a duplicate delivery joins the running one. */
export const metricCollectionWorkflowId = (publicationId: string): string => `metrics:${publicationId}`;
export const commentIngestionWorkflowId = (publicationId: string): string => `comments:${publicationId}`;

/**
 * Spec 15.1: the publishing runtime emits measurement.collection_due when a publication reaches `published`
 * (same transaction as the state move). The route starts metricCollectionWorkflowV1 on `ingest-metrics`; that
 * workflow starts commentIngestionWorkflowV1 on `ingest-comments` as an abandoned child when comments are readable.
 */
export function registerMeasurementOutboxRoutes(): void {
  registerOutboxRoute('measurement.collection_due', (evt) => {
    const p = evt.payload;
    const input = MetricCollectionWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      publicationId: p['publicationId'],
    });
    return {
      workflowType: METRIC_COLLECTION_WORKFLOW_TYPE,
      taskQueue: INGEST_METRICS_TASK_QUEUE,
      workflowId: metricCollectionWorkflowId(input.publicationId),
      args: [input],
    };
  });
}
