/**
 * Signals to a running agent-run workflow. The durable path is the outbox (agent.run_cancel_requested,
 * agent.proposal_decided → agentRunSignalRelayV1); a process that holds a Temporal client (worker-core) registers a
 * direct signaller here for low latency. Absent, nothing is lost: the relay delivers after commit.
 */
export interface WorkflowSignaller {
  signal(workflowId: string, signal: 'cancelRun' | 'proposalDecision', payload?: unknown): Promise<void>;
}

let signaller: WorkflowSignaller | null = null;
export const registerWorkflowSignaller = (s: WorkflowSignaller | null): void => {
  signaller = s;
};
export const workflowSignaller = (): WorkflowSignaller | null => signaller;
