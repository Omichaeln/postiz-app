import type {
  AgentRunRuntimeV1,
  AgentRunWorkflowInputV1,
  ActivityHooks,
  AgentRunFinishState,
  AgentRunResult,
  ContextResolveResultV1,
  DispatchToolInputV1,
  FinishRunInputV1,
  ModelMessage,
  PlanNextStepInputV1,
  PlanNextStepResultV1,
  RecordDecisionInputV1,
  ReserveBudgetInputV1,
  ReserveBudgetResultV1,
  ToolResult,
} from '@oremedia/contracts/agents';
import type { AgentRunState } from '@oremedia/contracts/agents';
import {
  BudgetExhaustedError,
  NotFoundError,
  OremediaError,
  PolicyDeniedError,
  ValidationFailedError,
} from '@oremedia/contracts/errors';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import { requireTenant, withTransaction, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { agentRunMachine, type AgentRunEvent } from '@oremedia/domain/state-machines/agent-run';
import { IllegalTransitionError } from '@oremedia/domain/state-machines/machine';
import {
  applyProposalBatch,
  assembleSystemPrompt,
  CreativeProposalPayload,
  assertRoutingAllowed,
  createReleaseOneRegistry,
  defaultContextResolverDeps,
  defaultDispatchDeps,
  dispatchToolDetailed,
  estimateCostMicros,
  initialUserMessage,
  resolveContextSnapshot,
  type AgentRunContext,
  type ContextResolverDeps,
  type ContextSnapshot,
  type DispatchDeps,
  type ModelAdapter,
  type ModelConfig,
  type ToolRegistry,
} from '@oremedia/ai';
import { resolveTenantContext } from '@oremedia/module-access';
import { budgets } from '@oremedia/module-billing';
import { audit, outbox } from '@oremedia/module-operations';
import { count, METRIC } from '@oremedia/observability';
import { AgentRunRepository, AgentStepRepository, ToolInvocationRepository } from './repositories';
import { transcripts as defaultTranscripts, type TranscriptStore } from './transcripts';

export interface AgentRuntimeOptions {
  adapter: ModelAdapter;
  modelConfig: ModelConfig;
  registry?: ToolRegistry;
  transcripts?: TranscriptStore;
  dispatchDeps?: DispatchDeps;
  contextDeps?: ContextResolverDeps;
  now?: () => Date;
}

const runsRepo = new AgentRunRepository();
const stepsRepo = new AgentStepRepository();
const invocationsRepo = new ToolInvocationRepository();

type RunRow = Awaited<ReturnType<typeof runsRepo.getById>>;

const TERMINAL: ReadonlySet<string> = new Set(agentRunMachine.terminal);
const isTerminal = (state: string): boolean => TERMINAL.has(state);

/** Spec 12.2 terminal-state mapping: the machine event that ends a run in the given state. */
const FINISH_EVENT: Record<AgentRunFinishState, AgentRunEvent> = {
  completed: 'complete',
  failed: 'fail',
  cancelled: 'cancel',
  budget_exhausted: 'budget_exhausted',
  policy_denied: 'policy_denied',
  waiting_expired: 'waiting_expired',
};

/** Spec 13.1: state is written only by transition(); an illegal move is a validation failure, never a retry. */
function transition(from: AgentRunState, event: AgentRunEvent): AgentRunState {
  try {
    return agentRunMachine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path: 'state', issue: err.message }],
        'The run is not in a state that allows this',
      );
    throw err;
  }
}

const actorRefOf = (p: ResolvedActorServicePrincipal) => ({ kind: p.kind, id: p.id });
const summary = (s: string): string => s.slice(0, 1000);

/**
 * Spec 12.2 activities behind agentRunWorkflowV1 (the activity host establishes tenant context and re-loads the
 * principal's grants; this runtime requires it). Every method re-loads the run row through the brand-scoped
 * repository, so a foreign or mismatched id is NOT_FOUND, and moves state only through agentRunMachine.
 */
export function createAgentRunRuntime(opts: AgentRuntimeOptions): AgentRunRuntimeV1 {
  const registry = opts.registry ?? createReleaseOneRegistry();
  const dispatchDeps = opts.dispatchDeps ?? defaultDispatchDeps(registry);
  const contextDeps = opts.contextDeps ?? defaultContextResolverDeps(registry);
  const store = opts.transcripts ?? defaultTranscripts();
  const now = opts.now ?? (() => new Date());

  async function loadRun(input: AgentRunWorkflowInputV1, tx?: Tx): Promise<RunRow> {
    const run = await runsRepo.getById(input.runId, tx);
    if (run.brandId !== input.brandId || run.tenantId !== input.tenantId)
      throw new NotFoundError('AgentRun', input.runId);
    return run;
  }

  /** The run's service principal as it is now (grants, status, max autonomy), through the same resolver as the API. */
  async function principalFor(
    input: AgentRunWorkflowInputV1,
    run: RunRow,
  ): Promise<ResolvedActorServicePrincipal> {
    const resolved = await resolveTenantContext(
      {
        kind: 'api_client',
        apiClientId: `run:${run.id}`,
        servicePrincipalId: run.servicePrincipalId,
        tenantId: input.tenantId,
        scopes: [],
      },
      input.tenantId,
      input.correlationId,
    );
    if (resolved.actor.kind !== 'service_principal')
      throw new PolicyDeniedError('principal_kind', 'A run acts as a service principal');
    return resolved.actor;
  }

  async function resolveContext(
    input: AgentRunWorkflowInputV1,
    run: RunRow,
    principal: ResolvedActorServicePrincipal,
  ) {
    return resolveContextSnapshot(
      {
        tenantId: input.tenantId,
        brandId: run.brandId,
        runId: run.id,
        correlationId: input.correlationId,
        principal,
        requestedAutonomy: run.autonomyMode,
        taskKind: run.taskKind,
        brief: run.brief,
      },
      contextDeps,
    );
  }

  async function appendStep(
    runId: string,
    kind: 'plan' | 'model_call' | 'tool_call' | 'validation',
    text: string,
    extras: { tokensIn?: number; tokensOut?: number; costMicros?: number; durationMs?: number },
    tx: Tx,
  ): Promise<string> {
    const id = newId('agentStep');
    await stepsRepo.append(
      {
        id,
        runId,
        index: await stepsRepo.nextIndex(runId, tx),
        kind,
        summary: summary(text),
        tokensIn: extras.tokensIn ?? 0,
        tokensOut: extras.tokensOut ?? 0,
        costMicros: extras.costMicros ?? 0,
        durationMs: extras.durationMs ?? 0,
      },
      tx,
    );
    return id;
  }

  /** Whether the transcript's last assistant turn issued this tool call (so its result has a place to go). */
  function hasToolUse(messages: ModelMessage[], toolUseId: string): boolean {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m?.role === 'assistant') return m.content.some((c) => c.type === 'tool_use' && c.id === toolUseId);
    }
    return false;
  }

  /** After a worker restart the verbatim transcript is gone: the recorded steps become a progress summary. */
  async function transcriptFor(run: RunRow): Promise<ModelMessage[]> {
    const existing = await store.get(run.id);
    if (existing && existing.length) return existing;
    const steps = await stepsRepo.allForRun(run.id);
    const invocations = await invocationsRepo.listForRun(run.id);
    const progress = steps
      .filter((s) => s.kind !== 'plan')
      .map((s) => {
        const calls = invocations.filter((i) => i.stepId === s.id).map((i) => `${i.toolName} → ${i.outcome}`);
        return `- step ${s.index} (${s.kind}): ${s.summary}${calls.length ? ` [${calls.join('; ')}]` : ''}`;
      });
    const text = progress.length
      ? `Progress so far (the conversation was resumed):\n${progress.join('\n')}\nContinue from here without repeating completed work.`
      : null;
    return text ? [{ role: 'user', content: [{ type: 'text', text }] }] : [];
  }

  return {
    async resolveContextSnapshot(input): Promise<ContextResolveResultV1> {
      const run = await loadRun(input);
      if (isTerminal(run.state))
        throw new ValidationFailedError([{ path: 'runId', issue: `run is ${run.state}` }]);
      const principal = await principalFor(input, run);
      const snapshot = await resolveContext(input, run, principal);
      await withTransaction(async (tx) => {
        const fresh = await runsRepo.lock(run.id, tx);
        const started = fresh.state === 'planned';
        const toState = started ? transition(fresh.state, 'start') : fresh.state;
        const deadline = new Date(
          Math.min(
            fresh.deadlineAt.getTime(),
            now().getTime() + snapshot.policy.budget.deadlineSeconds * 1000,
          ),
        );
        await runsRepo.update(
          fresh.id,
          fresh.version,
          {
            state: toState,
            contextSnapshotHash: snapshot.hash,
            skillVersionIds: snapshot.skills.map((s) => s.skillVersionId),
            autonomyMode: snapshot.policy.autonomyMode,
            deadlineAt: deadline,
          },
          tx,
        );
        if (started) {
          await appendStep(
            run.id,
            'plan',
            `context ${snapshot.hash.slice(0, 12)}: ${snapshot.skills.length} skill(s), ${snapshot.eligibleAssets.length} eligible asset(s), mode ${snapshot.policy.autonomyMode}, tools: ${snapshot.policy.allowedTools.join(', ') || '(none)'}`,
            {},
            tx,
          );
          for (const f of snapshot.findings)
            await appendStep(run.id, 'validation', `${f.code}: ${f.message}`, {}, tx);
          await audit.record(
            actorRefOf(principal),
            'agent.run.start',
            { type: 'agent_run', id: run.id },
            'allowed',
            tx,
            { runId: run.id, brandId: run.brandId, fromState: fresh.state, toState },
          );
        }
      });
      return {
        hash: snapshot.hash,
        autonomyMode: snapshot.policy.autonomyMode,
        allowedTools: snapshot.policy.allowedTools,
        budget: snapshot.policy.budget,
        skillVersionIds: snapshot.skills.map((s) => s.skillVersionId),
        findings: snapshot.findings.length,
      };
    },

    async reserveBudget(input: ReserveBudgetInputV1): Promise<ReserveBudgetResultV1> {
      const run = await loadRun(input);
      if (run.budgetReservationId)
        return { reservationId: run.budgetReservationId, reservedMicros: input.budget.maxCostMicros };
      const reservation = await budgets.reserveSpend(
        run.brandId,
        run.id,
        input.budget.maxCostMicros,
        run.deadlineAt,
      ); // atomic; throws BudgetExhausted
      await withTransaction(async (tx) => {
        const fresh = await runsRepo.lock(run.id, tx);
        await runsRepo.update(fresh.id, fresh.version, { budgetReservationId: reservation.id }, tx);
      });
      return { reservationId: reservation.id, reservedMicros: reservation.reservedMicros };
    },

    async planNextStep(input: PlanNextStepInputV1, hooks?: ActivityHooks): Promise<PlanNextStepResultV1> {
      const run = await loadRun(input);
      if (isTerminal(run.state)) return { kind: 'done', stepId: '', reason: `run_${run.state}` }; // cancelled through the API
      if (run.state !== 'running')
        throw new ValidationFailedError([{ path: 'runId', issue: `run is ${run.state}, not running` }]);
      if (now().getTime() > run.deadlineAt.getTime()) throw new BudgetExhaustedError('deadline');
      if (!run.budgetReservationId) throw new BudgetExhaustedError('no_reservation');
      const principal = await principalFor(input, run);
      const snapshot: ContextSnapshot = await resolveContext(input, run, principal);
      if (run.contextSnapshotHash && snapshot.hash !== run.contextSnapshotHash) {
        await withTransaction(async (tx) => {
          const fresh = await runsRepo.lock(run.id, tx);
          await runsRepo.update(fresh.id, fresh.version, { contextSnapshotHash: snapshot.hash }, tx);
          await appendStep(
            run.id,
            'validation',
            `context_changed: ${run.contextSnapshotHash} → ${snapshot.hash}`,
            {},
            tx,
          );
        });
      }
      const totals = await stepsRepo.totals(run.id);
      if (totals.modelCalls >= snapshot.policy.budget.maxSteps) throw new BudgetExhaustedError('run_steps');
      if (totals.tokens >= snapshot.policy.budget.maxTokens) throw new BudgetExhaustedError('run_tokens');
      await assertRoutingAllowed(input.tenantId, opts.modelConfig.provider, opts.modelConfig.model); // before EVERY call
      const prompt = { snapshot, taskKind: run.taskKind, brief: run.brief };
      const messages = await transcriptFor(run);
      if (messages.length === 0)
        messages.push({ role: 'user', content: [{ type: 'text', text: initialUserMessage(prompt) }] });
      hooks?.heartbeat(`model_call:${input.step}`);
      const started = now().getTime();
      const completion = await opts.adapter.complete({
        model: opts.modelConfig.model,
        system: assembleSystemPrompt(prompt),
        messages,
        tools: registry.schemasFor(snapshot.policy.allowedTools),
        maxOutputTokens: opts.modelConfig.maxOutputTokens,
        timeoutMs: opts.modelConfig.timeoutMs,
        metadata: { runId: run.id, tenantId: input.tenantId },
      });
      hooks?.heartbeat(`model_call:${input.step}:done`);
      const durationMs = now().getTime() - started;
      const costMicros = estimateCostMicros(opts.modelConfig, completion.usage);
      const text = completion.content.map((c) => c.text).join('\n');
      const done = completion.toolCalls.length === 0;
      const stepId = await withTransaction(async (tx) => {
        const fresh = await runsRepo.lock(run.id, tx);
        await runsRepo.update(fresh.id, fresh.version, { costMicros: fresh.costMicros + costMicros }, tx);
        return appendStep(
          run.id,
          'model_call',
          done
            ? `final (${completion.stopReason}): ${text}`
            : `${completion.toolCalls.length} tool call(s): ${completion.toolCalls.map((c) => c.name).join(', ')} (${completion.stopReason})`,
          {
            tokensIn: completion.usage.inputTokens,
            tokensOut: completion.usage.outputTokens,
            costMicros,
            durationMs,
          },
          tx,
        );
      });
      // Cost already incurred is ledgered first; exceeding the reservation ends the run with budget_exhausted.
      await budgets.consume(
        run.budgetReservationId,
        run.brandId,
        'model_tokens',
        completion.usage.inputTokens + completion.usage.outputTokens,
        'tokens',
        costMicros,
        stepId,
      );
      messages.push({
        role: 'assistant',
        content: [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...completion.toolCalls.map((c) => ({
            type: 'tool_use' as const,
            id: c.id,
            name: c.name,
            input: c.arguments,
          })),
        ],
      });
      await store.set(run.id, messages);
      if (done) return { kind: 'done', stepId, reason: completion.stopReason };
      return { kind: 'tool_calls', stepId, toolCalls: completion.toolCalls };
    },

    async dispatchTool(input: DispatchToolInputV1): Promise<ToolResult> {
      const run = await loadRun(input);
      const principal = await principalFor(input, run);
      let result: ToolResult;
      let record: Awaited<ReturnType<typeof dispatchToolDetailed>>['record'] | null = null;
      if (run.state !== 'running') {
        result = { kind: 'denied', reason: `run_${run.state}` };
      } else {
        const snapshot = await resolveContext(input, run, principal); // the policy comes from the server, never from the call
        const ctx: AgentRunContext = {
          runId: run.id,
          stepId: input.stepId,
          tenantId: input.tenantId,
          brandId: run.brandId,
          correlationId: input.correlationId,
          tenantContext: requireTenant(),
          principal,
          policy: { autonomyMode: snapshot.policy.autonomyMode, allowedTools: snapshot.policy.allowedTools },
          budgetReservationId: run.budgetReservationId,
          snapshot,
        };
        const outcome = await dispatchToolDetailed(input.call, ctx, dispatchDeps);
        result = outcome.result;
        record = outcome.record;
      }
      const outputRef =
        result.kind === 'ok'
          ? 'ok'
          : result.kind === 'proposal_requires_user'
            ? result.proposalRef
            : result.kind === 'denied'
              ? result.reason
              : 'invalid';
      await withTransaction(async (tx) => {
        await invocationsRepo.append(
          {
            id: newId('toolInvocation'),
            runId: run.id,
            stepId: input.stepId,
            toolName: input.call.name.slice(0, 80),
            inputHash: record?.inputHash ?? '0'.repeat(64),
            inputRedacted: record?.inputRedacted ?? {},
            policyDecision: record?.policyDecision ?? 'denied',
            policyReason:
              (record?.policyReason ?? (result.kind === 'denied' ? result.reason : null))?.slice(0, 80) ??
              null,
            outcome: record?.outcome ?? 'denied',
            outputRef: outputRef.slice(0, 200),
            proposalPayload: record?.proposal ?? null,
          },
          tx,
        );
        if (result.kind === 'proposal_requires_user') {
          const fresh = await runsRepo.lock(run.id, tx);
          const toState = transition(fresh.state, 'await_review');
          await runsRepo.update(fresh.id, fresh.version, { state: toState }, tx);
          await audit.record(
            actorRefOf(principal),
            'agent.run.await_review',
            { type: 'agent_run', id: run.id },
            'allowed',
            tx,
            { runId: run.id, brandId: run.brandId, fromState: fresh.state, toState },
          );
        }
      });
      if (result.kind === 'denied')
        count(METRIC.policyDenials, 1, {
          reason: result.reason,
          action: `tool:${input.call.name.slice(0, 80)}`,
        });
      // The result joins the transcript only when the matching tool_use is still there: after a worker restart
      // the verbatim transcript is gone and a lone tool_result would be rejected by the provider; the recorded
      // step and invocation reach the next planNextStep through the progress summary instead (transcriptFor).
      const messages = (await store.get(run.id)) ?? [];
      if (hasToolUse(messages, input.call.id)) {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: input.call.id,
              content: JSON.stringify(result),
              isError: result.kind === 'denied' || result.kind === 'invalid',
            },
          ],
        });
        await store.set(run.id, messages);
      }
      return result;
    },

    async recordDecision(input: RecordDecisionInputV1): Promise<void> {
      const run = await loadRun(input);
      if (isTerminal(run.state)) return; // cancelled while the decision was in flight
      if (run.state !== 'waiting_for_review')
        throw new ValidationFailedError([
          { path: 'runId', issue: `run is ${run.state}, not waiting_for_review` },
        ]);
      const proposal = await invocationsRepo.findProposal(run.id, input.decision.stepId);
      if (!proposal) throw new NotFoundError('Proposal', input.decision.stepId);
      const principal = await principalFor(input, run);
      let note = `proposal ${input.decision.stepId} ${input.decision.decision}`;
      await withTransaction(async (tx) => {
        if (input.decision.decision === 'accept') {
          try {
            // The verbatim payload (tool_invocations.proposal_payload), never the redacted input the history shows.
            const batch = CreativeProposalPayload.parse(proposal.proposalPayload);
            const applied = await applyProposalBatch(
              principal,
              {
                documentId: batch.documentId,
                baseRevisionId: batch.baseRevisionId,
                operations: batch.operations,
                summary: batch.summary,
                origin: 'agent',
                agentRunId: run.id,
              },
              tx,
              { autonomyMode: run.autonomyMode },
            );
            note += `: revision ${applied.revision.id} created`;
          } catch (err) {
            if (!(err instanceof OremediaError)) throw err;
            note += `: apply failed (${err.code.toLowerCase()})`; // stale head, lost rights: the model is told, the run continues
          }
        }
        const fresh = await runsRepo.lock(run.id, tx);
        const toState = transition(fresh.state, 'review_decided');
        await runsRepo.update(fresh.id, fresh.version, { state: toState }, tx);
        await appendStep(run.id, 'validation', note, {}, tx);
        await audit.record(
          actorRefOf(principal),
          'agent.run.review_decided',
          { type: 'agent_run', id: run.id },
          'allowed',
          tx,
          {
            runId: run.id,
            brandId: run.brandId,
            fromState: fresh.state,
            toState,
            reason: input.decision.decision,
          },
        );
      });
      const messages = (await store.get(run.id)) ?? [];
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: `Decision on your proposal: ${note}.` }],
      });
      await store.set(run.id, messages);
    },

    async finishRun(input: FinishRunInputV1): Promise<AgentRunResult> {
      const result = await withTransaction(async (tx) => {
        const fresh = await runsRepo.lock(input.runId, tx);
        if (fresh.brandId !== input.brandId) throw new NotFoundError('AgentRun', input.runId);
        const totals = await stepsRepo.totals(fresh.id, tx);
        if (isTerminal(fresh.state))
          return { runId: fresh.id, state: fresh.state, costMicros: totals.costMicros }; // idempotent
        const toState = transition(fresh.state, FINISH_EVENT[input.state]);
        await runsRepo.update(
          fresh.id,
          fresh.version,
          { state: toState, finishedAt: now(), costMicros: totals.costMicros },
          tx,
        );
        await audit.record(
          { kind: 'service_principal', id: fresh.servicePrincipalId },
          'agent.run.finish',
          { type: 'agent_run', id: fresh.id },
          'allowed',
          tx,
          { runId: fresh.id, brandId: fresh.brandId, fromState: fresh.state, toState },
        );
        await outbox.add(
          'agent.run_finished',
          { type: 'agent_run', id: fresh.id, version: fresh.version + 1 },
          { runId: fresh.id, state: toState, costMicros: totals.costMicros },
          tx,
          { brandId: fresh.brandId },
        );
        return { runId: fresh.id, state: toState, costMicros: totals.costMicros };
      });
      await store.delete(input.runId);
      return result;
    },

    async settleBudget(input: AgentRunWorkflowInputV1): Promise<void> {
      await loadRun(input);
      await budgets.settle(input.runId); // idempotent; releases the remainder
    },
  };
}
