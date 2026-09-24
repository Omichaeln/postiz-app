import {
  PublicationReconcileInputV1,
  PublicationSignalV1,
  PublicationWorkflowInputV1,
  TokenRefreshWorkflowInputV1,
} from '@oremedia/contracts/publishing';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Spec 4.4: worker-core hosts task queue `core` (publication, sweeper, token refresh and the signal relay). */
export const CORE_TASK_QUEUE = 'core';
export const PUBLICATION_WORKFLOW_TYPE = 'publicationWorkflowV1';
export const PUBLICATION_RECONCILE_WORKFLOW_TYPE = 'publicationReconcileWorkflowV1';
export const PUBLICATION_SIGNAL_RELAY_WORKFLOW_TYPE = 'publicationSignalRelayV1';
export const TOKEN_REFRESH_WORKFLOW_TYPE = 'tokenRefreshWorkflowV1';
export const PUBLICATION_SWEEPER_WORKFLOW_TYPE = 'publicationSweeperWorkflowV1';
/** One always-on sweeper per namespace. */
export const PUBLICATION_SWEEPER_WORKFLOW_ID = 'publication-sweeper';

/** Spec 4.4: one activity queue per provider so a slow platform cannot starve the others. */
export const publishTaskQueue = (providerKey: string): string => `publish-${providerKey}`;
export const tokenRefreshWorkflowId = (channelConnectionId: string): string =>
  `token-refresh:${channelConnectionId}`;

/**
 * Spec 14.2: publication.scheduled → publicationWorkflowV1 with the stable workflow id the command chose
 * (`pub:<publicationId>`, see common.ts); the outbox row is the dedupe authority. Cancel and reschedule are relayed
 * to the running workflow by a short relay workflow, so the API needs no Temporal client and the signal lands only
 * after the commit. A connect starts the connection's token refresh workflow.
 */
export function registerPublishingOutboxRoutes(): void {
  registerOutboxRoute('publication.scheduled', (evt) => {
    const p = evt.payload;
    const input = PublicationWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      publicationId: p['publicationId'],
    });
    return {
      workflowType: PUBLICATION_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: String(p['workflowId']),
      args: [input],
    };
  });
  const relay =
    (signal: 'cancel' | 'reschedule') => (evt: Parameters<Parameters<typeof registerOutboxRoute>[1]>[0]) => {
      const input = PublicationSignalV1.parse({ workflowId: String(evt.payload['workflowId']), signal });
      return {
        workflowType: PUBLICATION_SIGNAL_RELAY_WORKFLOW_TYPE,
        taskQueue: CORE_TASK_QUEUE,
        workflowId: `${input.workflowId}:signal:${evt.id}`,
        args: [input],
      };
    };
  registerOutboxRoute('publication.cancel_requested', relay('cancel'));
  registerOutboxRoute('publication.rescheduled', relay('reschedule'));
  registerOutboxRoute('publication.reconcile_requested', (evt) => {
    const p = evt.payload;
    const input = PublicationReconcileInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      publicationId: p['publicationId'],
      attemptId: p['attemptId'] ?? null,
      providerKey: p['providerKey'],
    });
    return {
      workflowType: PUBLICATION_RECONCILE_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: String(p['workflowId']),
      args: [input],
    };
  });
  registerOutboxRoute('channel.connected', (evt) => {
    const p = evt.payload;
    const input = TokenRefreshWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: p['actorKind'], id: p['actorId'] },
      correlationId: evt.correlationId,
      channelConnectionId: p['channelConnectionId'],
    });
    return {
      workflowType: TOKEN_REFRESH_WORKFLOW_TYPE,
      taskQueue: CORE_TASK_QUEUE,
      workflowId: tokenRefreshWorkflowId(input.channelConnectionId),
      args: [input],
    };
  });
}
