import {
  CancellationScope,
  condition,
  defineSignal,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type {
  AgentActivitiesV1,
  AgentRunFinishState,
  AgentRunResult,
  AgentRunSignalV1,
  AgentRunWorkflowInputV1,
  ModelActivitiesV1,
  ProposalDecision,
} from '@oremedia/contracts/agents';

/**
 * Spec 12.2: the run lifecycle. Temporal owns durable state and waits; the model loop is bounded inside activities.
 * Activities throw ApplicationFailure.nonRetryable(message, 'PolicyDenied' | 'BudgetExhausted' | 'ValidationFailed');
 * nonRetryableErrorTypes matches ApplicationFailure.type, not a JS class name. Once deployed this file is immutable;
 * changes ship as v2.
 */
export const proposalDecision = defineSignal<[ProposalDecision]>('proposalDecision');
export const cancelRun = defineSignal('cancelRun');

/** How long a run waits for a person to decide on a proposal before it ends as waiting_expired. */
export const PROPOSAL_WAIT = '72 hours';

/** Walks the failure chain (ActivityFailure → ApplicationFailure) for the failure `type` (never a class name). */
export function failureTypeOf(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
    const e = current as { type?: string | null; cause?: unknown };
    if (typeof e.type === 'string' && e.type) return e.type;
    current = e.cause;
  }
  return undefined;
}

/** Spec 12.2 terminal-state mapping for a failed activity. */
export function finishStateFor(err: unknown): AgentRunFinishState {
  const type = failureTypeOf(err);
  return type === 'BudgetExhausted'
    ? 'budget_exhausted'
    : type === 'PolicyDenied'
      ? 'policy_denied'
      : 'failed';
}

/** The durable waits, flags and scopes of the workflow, separated so the orchestration runs with fakes in unit tests. */
export interface AgentRunHost {
  cancelled(): boolean;
  decisionFor(stepId: string): ProposalDecision | undefined;
  /** Resolves true when a decision for the step (or a cancel) arrived within the wait, false when it expired. */
  waitForDecision(stepId: string): Promise<boolean>;
  /** CancellationScope.nonCancellable in the workflow; the identity in tests. */
  nonCancellable<T>(fn: () => Promise<T>): Promise<T>;
}

/** The orchestration, literally spec 12.2, with the activity proxies and signal state injected. */
export async function runAgentRun(
  act: AgentActivitiesV1,
  model: ModelActivitiesV1,
  input: AgentRunWorkflowInputV1,
  host: AgentRunHost,
): Promise<AgentRunResult> {
  const finish = (state: AgentRunFinishState) => act.finishRun({ ...input, state });
  try {
    const ctx = await act.resolveContextSnapshot(input); // brand snapshot, skills, eligible assets, facts, budgets
    await act.reserveBudget({ ...input, budget: ctx.budget }); // atomic; throws BudgetExhausted
    for (let step = 0; step < ctx.budget.maxSteps && !host.cancelled(); step++) {
      const next = await model.planNextStep({ ...input, step }); // bounded model call; returns tool calls or 'done'
      if (next.kind === 'done') break;
      for (const call of next.toolCalls) {
        const result = await act.dispatchTool({ ...input, step, stepId: next.stepId, call }); // policy + schema + budget in the activity
        if (result.kind === 'proposal_requires_user') {
          const ok = await host.waitForDecision(result.stepId);
          if (!ok || host.cancelled()) return finish(host.cancelled() ? 'cancelled' : 'waiting_expired');
          const decision = host.decisionFor(result.stepId);
          if (decision) await act.recordDecision({ ...input, decision });
        }
      }
    }
    return await finish(host.cancelled() ? 'cancelled' : 'completed');
  } catch (err) {
    return await finish(finishStateFor(err));
  } finally {
    await host.nonCancellable(() => act.settleBudget(input));
  }
}

export async function agentRunWorkflowV1(input: AgentRunWorkflowInputV1): Promise<AgentRunResult> {
  const act = proxyActivities<AgentActivitiesV1>({
    startToCloseTimeout: '5 minutes',
    retry: {
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['PolicyDenied', 'BudgetExhausted', 'ValidationFailed'],
    },
  });
  const model = proxyActivities<ModelActivitiesV1>({
    startToCloseTimeout: '3 minutes',
    heartbeatTimeout: '30 seconds',
    retry: {
      maximumAttempts: 2,
      nonRetryableErrorTypes: ['PolicyDenied', 'BudgetExhausted', 'ValidationFailed'],
    },
  });
  let cancelled = false;
  const decisions = new Map<string, ProposalDecision>();
  setHandler(cancelRun, () => {
    cancelled = true;
  });
  setHandler(proposalDecision, (d) => {
    decisions.set(d.stepId, d);
  });
  return runAgentRun(act, model, input, {
    cancelled: () => cancelled,
    decisionFor: (stepId) => decisions.get(stepId),
    waitForDecision: (stepId) => condition(() => decisions.has(stepId) || cancelled, PROPOSAL_WAIT),
    nonCancellable: (fn) => CancellationScope.nonCancellable(fn),
  });
}

/**
 * Relays a decision or a cancellation from the outbox to the running agent run (spec 12.2 signals). The API writes
 * the event in the decision's transaction; the relay signals only after that commit, so recordDecision always finds
 * the row. A relay for a run that already ended fails harmlessly (the workflow is gone).
 */
export async function agentRunSignalRelayV1(input: AgentRunSignalV1): Promise<void> {
  const handle = getExternalWorkflowHandle(input.workflowId);
  if (input.signal === 'cancelRun') await handle.signal(cancelRun);
  else await handle.signal(proposalDecision, input.decision);
}
