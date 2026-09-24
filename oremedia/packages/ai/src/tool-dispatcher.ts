import type { ModelToolCall, ToolResult } from '@oremedia/contracts/agents';
import { OremediaError, PolicyDeniedError } from '@oremedia/contracts/errors';
import type { Decision, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { hashCanonical } from '@oremedia/domain/hash';
import { policy } from '@oremedia/module-access';
import { budgets } from '@oremedia/module-billing';
import { audit } from '@oremedia/module-operations';
import type { ContextSnapshot } from './context-resolver';
import { registeredProviderJobStore, type ProviderJobStore } from './provider-jobs';
import { redactForRecord } from './redact';
import {
  ProposalRequest,
  type AnyToolDefinition,
  type ToolContext,
  type ToolRegistry,
} from './tool-registry';
import { defaultToolServices, type ToolServices } from './tools/services';

/** The run as the dispatcher needs it: tenant context, principal, the policy the resolver fixed, the reservation. */
export interface AgentRunContext {
  runId: string;
  stepId: string;
  tenantId: string;
  brandId: string;
  correlationId: string;
  tenantContext: TenantContext;
  principal: ResolvedActorServicePrincipal;
  policy: { autonomyMode: AutonomyMode; allowedTools: string[] };
  budgetReservationId: string | null;
  snapshot: ContextSnapshot | null;
}

export interface DispatchDeps {
  registry: ToolRegistry;
  policy: Pick<typeof policy, 'decide'>;
  audit: Pick<typeof audit, 'record'>;
  budgets: Pick<typeof budgets, 'consume'>;
  services: ToolServices;
  providerJobs: ProviderJobStore;
  /** The unit of work a tool runs in; tests inject a stub, production uses withTransaction. */
  transaction?: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  defaultTimeoutMs?: number;
  now?: () => Date;
}

/** What the run history records about one call besides the result (tool_invocations columns). */
export interface DispatchRecord {
  inputHash: string;
  inputRedacted: Record<string, unknown>;
  policyDecision: 'allowed' | 'denied' | 'invalid';
  policyReason: string | null;
  outcome: 'ok' | 'error' | 'denied' | 'invalid' | 'proposal';
  durationMs: number;
  /** A proposal's payload verbatim: what a person accepts is applied from this, never from the redacted input. */
  proposal: Record<string, unknown> | null;
}

export interface DispatchOutcome {
  result: ToolResult;
  record: DispatchRecord;
}

export function defaultDispatchDeps(registry: ToolRegistry): DispatchDeps {
  return {
    registry,
    policy,
    audit,
    budgets,
    services: defaultToolServices(),
    providerJobs: registeredProviderJobStore,
  };
}

/**
 * The charge key of one tool call (usage_ledger.idempotency_key): run, step and the model's tool_use id, hashed so
 * a provider's id length never matters. A retried activity for the same call charges once; distinct calls, even of
 * the same tool in the same step, each charge.
 */
export const toolCallChargeKey = (
  run: Pick<AgentRunContext, 'runId' | 'stepId'>,
  call: ModelToolCall,
): string => `tool_call:${hashCanonical({ runId: run.runId, stepId: run.stepId, toolCallId: call.id })}`;

const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export class ToolTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`tool ${name} timed out after ${ms} ms`);
    this.name = 'ToolTimeoutError';
  }
}

/** A tool's own reason for refusing (provider not configured, not available yet): a denial, not a failure. */
export class ToolDeniedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ToolDeniedError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolTimeoutError(name, ms)), ms);
  });
  // After a timeout the orphaned run keeps going until its next query, which fails on the closed transaction
  // handle (packages/db TransactionClosedError); that late rejection is expected and must not surface.
  p.catch(() => undefined);
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const deny = (reason: string): ToolResult => ({ kind: 'denied', reason });

/** Machine-readable reason for a domain error thrown by a tool (a foreign id, lost rights, a stale revision). */
const reasonOf = (err: OremediaError): string =>
  err instanceof PolicyDeniedError ? err.reason : err.code.toLowerCase();

/**
 * Spec 12.4, literally: an unknown or unlisted tool is denied before anything else (the denial itself is audited),
 * a schema failure goes back to the model as `invalid` (it counts as a step), then inside the run's tenant context
 * the service principal is authorised for the tool's action and resource, the invocation is audited with a redacted
 * input, costed tools consume from the reservation, the tool runs under a timeout and its output is parsed.
 */
export async function dispatchToolDetailed(
  call: ModelToolCall,
  run: AgentRunContext,
  deps: DispatchDeps,
): Promise<DispatchOutcome> {
  const now = deps.now ?? (() => new Date());
  const transaction = deps.transaction ?? withTransaction;
  const started = now().getTime();
  const inputHash = hashCanonical(call.arguments ?? null);
  const inputRedacted = redactForRecord(call.arguments);
  const actor = { kind: run.principal.kind, id: run.principal.id };
  const finish = (
    result: ToolResult,
    policyDecision: DispatchRecord['policyDecision'],
    policyReason: string | null,
    outcome: DispatchRecord['outcome'],
    proposal: Record<string, unknown> | null = null,
  ): DispatchOutcome => ({
    result,
    record: {
      inputHash,
      inputRedacted,
      policyDecision,
      policyReason,
      outcome,
      durationMs: now().getTime() - started,
      proposal,
    },
  });

  const def = deps.registry.get(call.name);
  if (!def || !run.policy.allowedTools.includes(def.name)) {
    await runInTenant(run.tenantContext, () =>
      deps.audit.record(
        actor,
        'agent.tool.denied',
        { type: 'agent_run', id: run.runId },
        { allowed: false, reason: 'tool_not_allowed' },
        undefined,
        {
          runId: run.runId,
          toolName: call.name.slice(0, 80),
          brandId: run.brandId,
          reason: 'tool_not_allowed',
        },
      ),
    );
    return finish(deny('tool_not_allowed'), 'denied', 'tool_not_allowed', 'denied');
  }

  const parsed = def.input.safeParse(call.arguments ?? {});
  if (!parsed.success) {
    return finish(
      {
        kind: 'invalid',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), issue: i.message })),
      },
      'invalid',
      'schema',
      'invalid',
    );
  }

  return runInTenant(run.tenantContext, async () => {
    const resource = def.resource
      ? def.resource(parsed.data, run)
      : { type: 'brand', tenantId: run.tenantId, brandId: run.brandId, id: run.brandId };
    const decision: Decision = await deps.policy.decide(run.principal, def.action, resource, {
      autonomyMode: run.policy.autonomyMode,
    });
    await deps.audit.record(
      actor,
      `agent.tool.${def.name}`,
      { type: 'agent_run', id: run.runId },
      decision,
      undefined,
      { runId: run.runId, toolName: def.name, brandId: run.brandId, reason: decision.reason },
    );
    if (!decision.allowed) return finish(deny(decision.reason), 'denied', decision.reason, 'denied');

    const unavailable = def.availability?.({ services: deps.services, run }) ?? null;
    if (unavailable) return finish(deny(unavailable), 'allowed', unavailable, 'denied');

    if (def.costEstimateMicros) {
      if (!run.budgetReservationId)
        return finish(deny('no_budget_reservation'), 'allowed', 'no_budget_reservation', 'denied');
      await deps.budgets.consume(
        run.budgetReservationId,
        run.brandId,
        def.costKind ?? 'tool_call',
        1,
        'call',
        def.costEstimateMicros(parsed.data),
        run.stepId,
        toolCallChargeKey(run, call),
      ); // throws BudgetExhausted: the run ends with budget_exhausted; charged once per tool call
    }

    try {
      // The timeout runs inside the unit of work: when it fires the transaction rolls back, so a tool that timed
      // out has done nothing (the model is told it was denied). Racing outside the transaction would let the
      // tool's writes commit later, after the model was told otherwise.
      const out = await transaction((tx) =>
        withTimeout(
          def.run(parsed.data, {
            run,
            toolCallId: call.id,
            actor: run.principal,
            snapshot: run.snapshot,
            services: deps.services,
            providerJobs: deps.providerJobs,
            tx,
            now,
          }),
          def.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
          def.name,
        ),
      );
      if (out instanceof ProposalRequest)
        return finish(
          { kind: 'proposal_requires_user', stepId: run.stepId, proposalRef: out.proposalRef },
          'allowed',
          null,
          'proposal',
          out.payload,
        );
      return finish({ kind: 'ok', output: def.output.parse(out) }, 'allowed', null, 'ok');
    } catch (err) {
      if (err instanceof ToolDeniedError) return finish(deny(err.reason), 'allowed', err.reason, 'denied');
      if (err instanceof ToolTimeoutError)
        return finish(deny('tool_timeout'), 'allowed', 'tool_timeout', 'error');
      if (err instanceof OremediaError && err.code !== 'BUDGET_EXHAUSTED' && err.code !== 'INTERNAL')
        return finish(deny(reasonOf(err)), 'allowed', reasonOf(err), 'denied');
      throw err; // infrastructure failures retry through Temporal
    }
  });
}

/** Spec 12.4 signature: the result the model sees. */
export async function dispatchTool(
  call: ModelToolCall,
  run: AgentRunContext,
  deps: DispatchDeps,
): Promise<ToolResult> {
  return (await dispatchToolDetailed(call, run, deps)).result;
}

/** Exhaustive over the registry: nothing an agent can call has an external effect (spec 12.4). */
export function assertNoExternalTools(registry: ToolRegistry): void {
  for (const name of registry.names()) {
    const def = registry.get(name) as AnyToolDefinition;
    if (def.effect === 'external') throw new Error(`tool ${name} has effect external`);
  }
}

export type { ToolContext };
