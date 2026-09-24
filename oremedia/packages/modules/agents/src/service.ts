import { z } from 'zod';
import {
  RunApproveProposal,
  RunCancel,
  RunGet,
  RunStart,
  RunSteps,
  type AgentRunState,
} from '@oremedia/contracts/agents';
import { OperationBatch } from '@oremedia/contracts/creative';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { TaskKind } from '@oremedia/contracts/skills';
import { requireTenant, type Tx } from '@oremedia/db';
import { effectiveAutonomy } from '@oremedia/domain/autonomy';
import { newId } from '@oremedia/domain/ids';
import { agentRunMachine, type AgentRunEvent } from '@oremedia/domain/state-machines/agent-run';
import { IllegalTransitionError } from '@oremedia/domain/state-machines/machine';
import {
  applyProposalBatch,
  assertRoutingAllowed,
  CreativeProposalPayload,
  entitlementAutonomy,
  modelConfigFromEnv,
  tenantPolicyFor,
  type ModelConfig,
} from '@oremedia/ai';
import { policy, ServicePrincipalRepository } from '@oremedia/module-access';
import { budgets, entitlements } from '@oremedia/module-billing';
import { brandService } from '@oremedia/module-brand';
import { audit, killSwitch, outbox } from '@oremedia/module-operations';
import { runWorkflowId } from './outbox-routes';
import { AgentRunRepository, AgentStepRepository, ToolInvocationRepository } from './repositories';

const runsRepo = new AgentRunRepository();
const stepsRepo = new AgentStepRepository();
const invocationsRepo = new ToolInvocationRepository();
const principalsRepo = new ServicePrincipalRepository();

type RunRow = Awaited<ReturnType<typeof runsRepo.getById>>;

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const brandResource = (run: RunRow) => ({
  type: 'agent_run',
  tenantId: run.tenantId,
  brandId: run.brandId,
  id: run.id,
});

/** The initial deadline before the context resolver tightens it to the skill budget (spec 10.1 max 1800 s). */
const INITIAL_DEADLINE_SECONDS = 1800;

/** Model configuration is read once per process from the environment (Appendix A names). */
let modelConfig: ModelConfig | null = null;
const currentModelConfig = (): ModelConfig => (modelConfig ??= modelConfigFromEnv());
/** Test seam / composition: pin the configuration explicitly. */
export const configureAgentModel = (cfg: ModelConfig | null): void => {
  modelConfig = cfg;
};

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
function transition(from: AgentRunState, event: AgentRunEvent, path: string): AgentRunState {
  try {
    return agentRunMachine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

const toRunDto = (r: RunRow) => ({
  id: r.id,
  brandId: r.brandId,
  state: r.state,
  taskKind: r.taskKind,
  autonomyMode: r.autonomyMode,
  servicePrincipalId: r.servicePrincipalId,
  initiatorKind: r.initiatorKind,
  initiatorId: r.initiatorId,
  brief: r.brief,
  contextSnapshotHash: r.contextSnapshotHash,
  skillVersionIds: r.skillVersionIds,
  modelConfig: r.modelConfig,
  budgetReservationId: r.budgetReservationId,
  costMicros: r.costMicros,
  deadlineAt: r.deadlineAt.toISOString(),
  workflowId: r.workflowId,
  correlationId: r.correlationId,
  finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  version: r.version,
});

/**
 * Spec 7.5 agents router commands. A run is a brand-owned row (NOT_FOUND for a foreign id), starts through the
 * outbox (agent.run_requested → agentRunWorkflowV1 on queue `agents`) and changes state only through
 * agentRunMachine. The model never widens any of this: autonomy is min(requested, principal, tenant, entitlement).
 */
export const agentsService = {
  runs: {
    async start(actor: ResolvedActor, input: z.infer<typeof RunStart>, tx: Tx) {
      const parsed = RunStart.parse(input);
      const taskKind = TaskKind.safeParse(parsed.taskKind);
      if (!taskKind.success)
        throw new ValidationFailedError([
          { path: 'taskKind', issue: `unknown task kind ${parsed.taskKind}` },
        ]);
      const { tenantId, correlationId } = requireTenant();
      await brandService.assertExist([parsed.brandId], tx); // NOT_FOUND for a foreign brand
      await policy.assert(
        actor,
        'agent.start_run',
        { type: 'brand', tenantId, brandId: parsed.brandId, id: parsed.brandId },
        {},
        tx,
      );
      if (await killSwitch.isOn('agent_starts', parsed.brandId, tx))
        throw new PolicyDeniedError('kill_switch_engaged', 'Agent starts are paused for this brand');
      await entitlements.assert(tenantId, 'generation_budget_micros_month', tx);
      const principal = await principalsRepo.getById(parsed.servicePrincipalId, tx); // NOT_FOUND for a foreign principal
      if (principal.status !== 'active')
        throw new ValidationFailedError([{ path: 'servicePrincipalId', issue: 'revoked' }]);
      const [tenantPolicy, ent] = await Promise.all([
        tenantPolicyFor(tenantId, correlationId, tx),
        entitlements.resolve(tenantId, tx),
      ]);
      const autonomyMode = effectiveAutonomy(
        parsed.requestedAutonomy,
        principal.maxAutonomy,
        tenantPolicy.maxAutonomy,
        entitlementAutonomy(ent),
      );
      const cfg = currentModelConfig();
      await assertRoutingAllowed(tenantId, cfg.provider, cfg.model);
      const id = newId('agentRun');
      const workflowId = runWorkflowId(id);
      await runsRepo.create(
        {
          id,
          brandId: parsed.brandId,
          initiatorKind: actor.kind === 'user' ? 'user' : 'system',
          initiatorId: actor.id,
          servicePrincipalId: principal.id,
          autonomyMode,
          taskKind: taskKind.data,
          brief: parsed.brief,
          contextSnapshotHash: null,
          skillVersionIds: [],
          modelConfig: { provider: cfg.provider, model: cfg.model },
          state: 'planned',
          budgetReservationId: null,
          costMicros: 0,
          deadlineAt: new Date(Date.now() + INITIAL_DEADLINE_SECONDS * 1000),
          workflowId,
          correlationId,
        },
        tx,
      );
      await audit.record(actorRef(actor), 'agent.run.request', { type: 'agent_run', id }, 'allowed', tx, {
        brandId: parsed.brandId,
        runId: id,
        toState: 'planned',
      });
      await outbox.add(
        'agent.run_requested',
        { type: 'agent_run', id, version: 0 },
        {
          runId: id,
          brandId: parsed.brandId,
          servicePrincipalId: principal.id,
          initiatorKind: actor.kind,
          initiatorId: actor.id,
          taskKind: taskKind.data,
          autonomyMode,
        },
        tx,
        { brandId: parsed.brandId },
      );
      return { runId: id, state: 'planned' as const, autonomyMode, workflowId, version: 0 };
    },

    async get(actor: ResolvedActor, input: z.infer<typeof RunGet>, tx?: Tx) {
      const parsed = RunGet.parse(input);
      const run = await runsRepo.getById(parsed.runId, tx);
      await policy.assert(actor, 'brand.read', brandResource(run), {}, tx);
      return toRunDto(run);
    },

    /** Spec 13.5: cancel moves the row (machine), releases the reservation and signals the workflow via the outbox. */
    async cancel(actor: ResolvedActor, input: z.infer<typeof RunCancel>, tx: Tx) {
      const parsed = RunCancel.parse(input);
      const run = await runsRepo.lock(parsed.runId, tx);
      await policy.assert(actor, 'agent.cancel_run', { ...brandResource(run), state: run.state }, {}, tx);
      const toState = transition(run.state, 'cancel', 'runId');
      await runsRepo.update(run.id, run.version, { state: toState, finishedAt: new Date() }, tx);
      await audit.record(
        actorRef(actor),
        'agent.run.cancel',
        { type: 'agent_run', id: run.id },
        'allowed',
        tx,
        { brandId: run.brandId, runId: run.id, fromState: run.state, toState, reason: parsed.reason ?? null },
      );
      await outbox.add(
        'agent.run_cancel_requested',
        { type: 'agent_run', id: run.id, version: run.version + 1 },
        { runId: run.id, requestedByKind: actor.kind, requestedById: actor.id },
        tx,
        { brandId: run.brandId },
      );
      // Released with the command: if this transaction does not commit, the run keeps its reservation. The
      // cancel signal reaches the workflow through the outbox relay only after the commit (no direct signal
      // can be sent from inside an open transaction without racing the workflow against uncommitted state).
      await budgets.release(run.id, tx); // idempotent; the workflow's settle is a no-op afterwards
      return { runId: run.id, state: toState, version: run.version + 1 };
    },

    /** Steps with their tool invocations: inputs redacted, outcomes and costs; never private reasoning (spec 12.7). */
    async steps(actor: ResolvedActor, input: z.infer<typeof RunSteps>, tx?: Tx) {
      const parsed = RunSteps.parse(input);
      const run = await runsRepo.getById(parsed.runId, tx);
      await policy.assert(actor, 'brand.read', brandResource(run), {}, tx);
      const page = await stepsRepo.listForRun(run.id, parsed.page, tx);
      const invocations = await invocationsRepo.listForSteps(
        run.id,
        page.items.map((s) => s.id),
        tx,
      );
      return {
        items: page.items.map((s) => ({
          id: s.id,
          index: s.index,
          kind: s.kind,
          summary: s.summary,
          tokensIn: s.tokensIn,
          tokensOut: s.tokensOut,
          costMicros: s.costMicros,
          durationMs: s.durationMs,
          createdAt: s.createdAt.toISOString(),
          invocations: invocations
            .filter((i) => i.stepId === s.id)
            .map((i) => ({
              id: i.id,
              toolName: i.toolName,
              inputHash: i.inputHash,
              inputRedacted: i.inputRedacted,
              policyDecision: i.policyDecision,
              policyReason: i.policyReason,
              outcome: i.outcome,
              outputRef: i.outputRef,
              proposal: i.proposalPayload ?? null,
              createdAt: i.createdAt.toISOString(),
            })),
        })),
        nextCursor: page.nextCursor,
      };
    },

    /**
     * Spec 12.2 proposalDecision: a person accepts, rejects or modifies a proposal. The decision is recorded and
     * relayed to the workflow after commit (agent.proposal_decided); recordDecision applies an accepted batch as the
     * run's principal. `modify` applies the person's own batch here, as the person (origin user).
     */
    async approveProposal(actor: ResolvedActor, input: z.infer<typeof RunApproveProposal>, tx: Tx) {
      const parsed = RunApproveProposal.parse(input);
      const run = await runsRepo.lock(parsed.runId, tx);
      await policy.assert(actor, 'creative.edit', brandResource(run), {}, tx);
      if (actor.kind !== 'user') throw new PolicyDeniedError('agent_never', 'A person decides on proposals');
      if (run.state !== 'waiting_for_review')
        throw new ValidationFailedError([
          { path: 'runId', issue: `run is ${run.state}, not waiting_for_review` },
        ]);
      const proposal = await invocationsRepo.findProposal(run.id, parsed.stepId, tx);
      if (!proposal) throw new NotFoundError('Proposal', parsed.stepId);
      let appliedRevisionId: string | null = null;
      if (parsed.decision === 'modify') {
        const proposed = CreativeProposalPayload.parse(proposal.proposalPayload);
        const batch = OperationBatch.extend({ documentId: z.string() }).parse({
          ...(parsed.batch as object),
          origin: 'user',
        });
        if (batch.documentId !== proposed.documentId)
          throw new ValidationFailedError([{ path: 'batch.documentId', issue: 'must match the proposal' }]);
        const applied = await applyProposalBatch(actor, batch, tx);
        appliedRevisionId = applied.revision.id;
      }
      await stepsRepo.append(
        {
          id: newId('agentStep'),
          runId: run.id,
          index: await stepsRepo.nextIndex(run.id, tx),
          kind: 'validation',
          summary: `proposal ${parsed.stepId} ${parsed.decision} by user ${actor.id}${appliedRevisionId ? `: revision ${appliedRevisionId}` : ''}`,
          tokensIn: 0,
          tokensOut: 0,
          costMicros: 0,
          durationMs: 0,
        },
        tx,
      );
      await audit.record(
        actorRef(actor),
        'agent.proposal.decide',
        { type: 'agent_run', id: run.id },
        'allowed',
        tx,
        { brandId: run.brandId, runId: run.id, reason: parsed.decision, revisionId: appliedRevisionId },
      );
      await outbox.add(
        'agent.proposal_decided',
        { type: 'agent_run', id: run.id, version: run.version },
        {
          runId: run.id,
          stepId: parsed.stepId,
          decision: parsed.decision,
          decidedByKind: actor.kind,
          decidedById: actor.id,
        },
        tx,
        { brandId: run.brandId },
      );
      return { runId: run.id, stepId: parsed.stepId, decision: parsed.decision, appliedRevisionId };
    },
  },
};
