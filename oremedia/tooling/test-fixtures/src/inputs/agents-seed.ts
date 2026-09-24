import { agentRuns, agentSteps, toolInvocations } from '@oremedia/db/schema/agents';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** Per tenant, on brand 1: one planned agent run with one step and one tool invocation (spec 19.3 agents.*). */
export const AGENTS_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const agentRunId = newId('agentRun');
  const agentStepId = newId('agentStep');
  const toolInvocationId = newId('toolInvocation');
  await db.insert(agentRuns).values({
    id: agentRunId,
    tenantId,
    brandId,
    initiatorKind: 'user',
    initiatorId: ownerUserId,
    servicePrincipalId: newId('servicePrincipal'),
    autonomyMode: 'create',
    taskKind: 'copywriting',
    brief: { objective: 'seeded' },
    contextSnapshotHash: null,
    skillVersionIds: [],
    modelConfig: { provider: 'fake', model: 'seed' },
    state: 'planned',
    budgetReservationId: null,
    costMicros: 0,
    deadlineAt: new Date(Date.now() + 1800_000),
    workflowId: `run:${agentRunId}`,
    correlationId: 'seed',
  });
  await db.insert(agentSteps).values({
    id: agentStepId,
    tenantId,
    runId: agentRunId,
    index: 0,
    kind: 'plan',
    summary: 'seeded plan step',
  });
  await db.insert(toolInvocations).values({
    id: toolInvocationId,
    tenantId,
    runId: agentRunId,
    stepId: agentStepId,
    toolName: 'brand.getSnapshot',
    inputHash: hashCanonical({}),
    inputRedacted: {},
    policyDecision: 'allowed',
    outcome: 'ok',
    outputRef: 'ok',
  });
  return { agentRunId, agentStepId, toolInvocationId };
};
