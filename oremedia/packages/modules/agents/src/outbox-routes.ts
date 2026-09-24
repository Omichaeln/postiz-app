import { AgentRunSignalV1, AgentRunWorkflowInputV1 } from '@oremedia/contracts/agents';
import { registerOutboxRoute } from '@oremedia/module-operations';

/** Spec 4.4: worker-core hosts the `agents` task queue (authority-bearing work). */
export const AGENTS_TASK_QUEUE = 'agents';
export const AGENT_RUN_WORKFLOW_TYPE = 'agentRunWorkflowV1';
export const AGENT_SIGNAL_RELAY_WORKFLOW_TYPE = 'agentRunSignalRelayV1';

export const runWorkflowId = (runId: string): string => `run:${runId}`;

/**
 * Spec 12.2: runs.start → agentRunWorkflowV1 (workflow id `run:<runId>`; the outbox row is the dedupe authority).
 * Decisions and cancellations are relayed to the running workflow by a short relay workflow that signals it, so the
 * API needs no Temporal client and the signal is delivered only after the decision row committed.
 */
export function registerAgentOutboxRoutes(): void {
  registerOutboxRoute('agent.run_requested', (evt) => {
    const p = evt.payload;
    const input = AgentRunWorkflowInputV1.parse({
      tenantId: evt.tenantId,
      actor: { kind: 'service_principal', id: p['servicePrincipalId'] },
      correlationId: evt.correlationId,
      runId: p['runId'],
      brandId: p['brandId'],
    });
    return {
      workflowType: AGENT_RUN_WORKFLOW_TYPE,
      taskQueue: AGENTS_TASK_QUEUE,
      workflowId: runWorkflowId(input.runId),
      args: [input],
    };
  });
  registerOutboxRoute('agent.proposal_decided', (evt) => {
    const p = evt.payload;
    const signal = AgentRunSignalV1.parse({
      workflowId: runWorkflowId(String(p['runId'])),
      signal: 'proposalDecision',
      decision: { stepId: p['stepId'], decision: p['decision'] },
    });
    return {
      workflowType: AGENT_SIGNAL_RELAY_WORKFLOW_TYPE,
      taskQueue: AGENTS_TASK_QUEUE,
      workflowId: `${signal.workflowId}:signal:${evt.id}`,
      args: [signal],
    };
  });
  registerOutboxRoute('agent.run_cancel_requested', (evt) => {
    const signal = AgentRunSignalV1.parse({
      workflowId: runWorkflowId(String(evt.payload['runId'])),
      signal: 'cancelRun',
    });
    return {
      workflowType: AGENT_SIGNAL_RELAY_WORKFLOW_TYPE,
      taskQueue: AGENTS_TASK_QUEUE,
      workflowId: `${signal.workflowId}:signal:${evt.id}`,
      args: [signal],
    };
  });
}
