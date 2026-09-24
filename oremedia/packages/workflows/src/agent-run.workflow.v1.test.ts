import { describe, expect, it } from 'vitest';
import type {
  AgentActivitiesV1,
  AgentRunWorkflowInputV1,
  ModelActivitiesV1,
  PlanNextStepResultV1,
  ProposalDecision,
  ToolResult,
} from '@oremedia/contracts/agents';
import { failureTypeOf, finishStateFor, runAgentRun, type AgentRunHost } from './agent-run.workflow.v1';

const input: AgentRunWorkflowInputV1 = {
  tenantId: 'ten_A',
  actor: { kind: 'service_principal', id: 'sp_1' },
  correlationId: 'corr_wf',
  runId: 'run_1',
  brandId: 'brd_1',
};
const budget = { maxSteps: 3, maxTokens: 1000, maxCostMicros: 1000, maxVariants: 1, deadlineSeconds: 60 };

/** An activity failure as the workflow sees it: ActivityFailure → ApplicationFailure with a `type`. */
const activityFailure = (type: string) =>
  Object.assign(new Error('activity failed'), {
    name: 'ActivityFailure',
    cause: Object.assign(new Error(type), { name: 'ApplicationFailure', type }),
  });

function fakes(opts: {
  plans?: PlanNextStepResultV1[];
  tools?: Record<string, ToolResult>;
  overrides?: Partial<AgentActivitiesV1 & ModelActivitiesV1>;
  decisions?: Record<string, ProposalDecision>;
  waitResult?: boolean;
  cancelAfterPlans?: number;
  cancelOnWait?: boolean;
}) {
  const calls: Array<{ name: string; input: unknown }> = [];
  let planIndex = 0;
  let cancelled = false;
  const decided = new Map(Object.entries(opts.decisions ?? {}));
  const base: AgentActivitiesV1 & ModelActivitiesV1 = {
    resolveContextSnapshot: async () => ({
      hash: 'h',
      autonomyMode: 'create',
      allowedTools: ['facts.list'],
      budget,
      skillVersionIds: [],
      findings: 0,
    }),
    reserveBudget: async () => ({ reservationId: 'br_1', reservedMicros: 1000 }),
    planNextStep: async () => {
      const plan = opts.plans?.[planIndex++] ?? { kind: 'done', stepId: 'step_done', reason: 'end_turn' };
      if (opts.cancelAfterPlans !== undefined && planIndex >= opts.cancelAfterPlans) cancelled = true;
      return plan;
    },
    dispatchTool: async (i) => opts.tools?.[i.call.name] ?? { kind: 'ok', output: {} },
    recordDecision: async () => undefined,
    finishRun: async (i) => ({ runId: i.runId, state: i.state, costMicros: 42 }),
    settleBudget: async () => undefined,
    ...opts.overrides,
  };
  const acts = Object.fromEntries(
    (Object.keys(base) as Array<keyof typeof base>).map((k) => [
      k,
      async (arg: never) => {
        calls.push({ name: k, input: arg });
        return (base[k] as (a: never) => Promise<unknown>)(arg);
      },
    ]),
  ) as unknown as AgentActivitiesV1 & ModelActivitiesV1;
  const signals: AgentRunHost = {
    cancelled: () => cancelled,
    decisionFor: (stepId) => decided.get(stepId),
    waitForDecision: async (stepId) => {
      if (opts.cancelOnWait) cancelled = true;
      return opts.waitResult ?? (decided.has(stepId) || cancelled);
    },
    nonCancellable: (fn) => fn(),
  };
  return { acts, signals, calls, names: () => calls.map((c) => c.name) };
}

const toolCall = (name: string) => ({ id: `toolu_${name}`, name, arguments: {} });

describe('agentRunWorkflowV1 orchestration (spec 12.2)', () => {
  it('resolves context, reserves the budget, loops plan → dispatch until done, finishes completed and settles', async () => {
    const f = fakes({
      plans: [
        {
          kind: 'tool_calls',
          stepId: 'step_1',
          toolCalls: [toolCall('facts.list'), toolCall('brand.getSnapshot')],
        },
        { kind: 'tool_calls', stepId: 'step_2', toolCalls: [toolCall('facts.list')] },
        { kind: 'done', stepId: 'step_3', reason: 'end_turn' },
      ],
    });
    const result = await runAgentRun(f.acts, f.acts, input, f.signals);
    expect(result).toEqual({ runId: 'run_1', state: 'completed', costMicros: 42 });
    expect(f.names()).toEqual([
      'resolveContextSnapshot',
      'reserveBudget',
      'planNextStep',
      'dispatchTool',
      'dispatchTool',
      'planNextStep',
      'dispatchTool',
      'planNextStep',
      'finishRun',
      'settleBudget',
    ]);
    expect(f.calls[1]?.input).toMatchObject({ runId: 'run_1', budget });
    expect(f.calls[3]?.input).toMatchObject({ step: 0, stepId: 'step_1', call: toolCall('facts.list') });
  });

  it('stops at the step budget even when the model never says done', async () => {
    const plans: PlanNextStepResultV1[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'tool_calls',
      stepId: `s${i}`,
      toolCalls: [toolCall('facts.list')],
    }));
    const f = fakes({ plans });
    expect((await runAgentRun(f.acts, f.acts, input, f.signals)).state).toBe('completed');
    expect(f.names().filter((n) => n === 'planNextStep')).toHaveLength(budget.maxSteps);
  });

  it('a proposal waits for the decision, records it and continues', async () => {
    const f = fakes({
      plans: [
        { kind: 'tool_calls', stepId: 'step_1', toolCalls: [toolCall('creative.proposeOperations')] },
        { kind: 'done', stepId: 'step_2', reason: 'end_turn' },
      ],
      tools: {
        'creative.proposeOperations': {
          kind: 'proposal_requires_user',
          stepId: 'step_1',
          proposalRef: 'hash',
        },
      },
      decisions: { step_1: { stepId: 'step_1', decision: 'accept' } },
    });
    const result = await runAgentRun(f.acts, f.acts, input, f.signals);
    expect(result.state).toBe('completed');
    expect(f.names()).toEqual([
      'resolveContextSnapshot',
      'reserveBudget',
      'planNextStep',
      'dispatchTool',
      'recordDecision',
      'planNextStep',
      'finishRun',
      'settleBudget',
    ]);
    expect(f.calls.find((c) => c.name === 'recordDecision')?.input).toMatchObject({
      decision: { stepId: 'step_1', decision: 'accept' },
    });
  });

  it('an expired wait ends the run as waiting_expired without recording a decision; settle still runs', async () => {
    const f = fakes({
      plans: [{ kind: 'tool_calls', stepId: 'step_1', toolCalls: [toolCall('creative.proposeOperations')] }],
      tools: {
        'creative.proposeOperations': {
          kind: 'proposal_requires_user',
          stepId: 'step_1',
          proposalRef: 'hash',
        },
      },
      waitResult: false,
    });
    expect((await runAgentRun(f.acts, f.acts, input, f.signals)).state).toBe('waiting_expired');
    expect(f.names()).toEqual([
      'resolveContextSnapshot',
      'reserveBudget',
      'planNextStep',
      'dispatchTool',
      'finishRun',
      'settleBudget',
    ]);
    expect(f.calls.at(-2)?.input).toMatchObject({ state: 'waiting_expired' });
  });

  it('a cancel during the wait ends the run as cancelled', async () => {
    const f = fakes({
      plans: [{ kind: 'tool_calls', stepId: 'step_1', toolCalls: [toolCall('creative.proposeOperations')] }],
      tools: {
        'creative.proposeOperations': {
          kind: 'proposal_requires_user',
          stepId: 'step_1',
          proposalRef: 'hash',
        },
      },
      cancelOnWait: true,
    });
    expect((await runAgentRun(f.acts, f.acts, input, f.signals)).state).toBe('cancelled');
    expect(f.names()).not.toContain('recordDecision');
    expect(f.names().at(-1)).toBe('settleBudget');
  });

  it('a cancel between steps ends the loop and finishes cancelled', async () => {
    const f = fakes({
      plans: Array.from({ length: 3 }, (_, i) => ({
        kind: 'tool_calls' as const,
        stepId: `s${i}`,
        toolCalls: [toolCall('facts.list')],
      })),
      cancelAfterPlans: 1,
    });
    expect((await runAgentRun(f.acts, f.acts, input, f.signals)).state).toBe('cancelled');
    expect(f.names().filter((n) => n === 'planNextStep')).toHaveLength(1);
  });

  it.each([
    ['BudgetExhausted', 'budget_exhausted'],
    ['PolicyDenied', 'policy_denied'],
    ['ValidationFailed', 'failed'],
    ['SomethingElse', 'failed'],
  ] as const)('maps an activity failure of type %s to %s and always settles', async (type, state) => {
    const f = fakes({
      overrides: {
        reserveBudget: async () => {
          throw activityFailure(type);
        },
      },
    });
    expect((await runAgentRun(f.acts, f.acts, input, f.signals)).state).toBe(state);
    expect(f.names()).toEqual(['resolveContextSnapshot', 'reserveBudget', 'finishRun', 'settleBudget']);
  });

  it('a denied context resolution ends as policy_denied before any budget is reserved', async () => {
    const f = fakes({
      overrides: {
        resolveContextSnapshot: async () => {
          throw activityFailure('PolicyDenied');
        },
      },
    });
    expect((await runAgentRun(f.acts, f.acts, input, f.signals)).state).toBe('policy_denied');
    expect(f.names()).toEqual(['resolveContextSnapshot', 'finishRun', 'settleBudget']);
  });

  it('settle runs even when finishing itself fails, and the failure propagates', async () => {
    const f = fakes({
      overrides: {
        finishRun: async () => {
          throw new Error('db down');
        },
      },
    });
    await expect(runAgentRun(f.acts, f.acts, input, f.signals)).rejects.toThrow('db down');
    expect(f.names().at(-1)).toBe('settleBudget');
  });

  it('failureTypeOf reads the ApplicationFailure type through the cause chain, never a class name', () => {
    expect(failureTypeOf(activityFailure('BudgetExhausted'))).toBe('BudgetExhausted');
    expect(failureTypeOf(new Error('plain'))).toBeUndefined();
    expect(finishStateFor({ name: 'BudgetExhaustedError' })).toBe('failed');
    expect(finishStateFor({ cause: { type: 'PolicyDenied' } })).toBe('policy_denied');
  });
});
