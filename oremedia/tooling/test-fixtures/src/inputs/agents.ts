import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** One entry per agents.* procedure, every id pointing at the foreign tenant's rows from AGENTS_SEED (spec 19.3). */
export const AGENTS_INPUTS: Record<string, CrossTenantFixture> = {
  'agents.runs.start': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      servicePrincipalId: f['servicePrincipalId'],
      requestedAutonomy: 'create',
      taskKind: 'copywriting',
      brief: { objective: 'foreign' },
    }),
  },
  'agents.runs.get': { buildInput: (f) => ({ runId: f['agentRunId'] }) },
  'agents.runs.cancel': { buildInput: (f) => ({ runId: f['agentRunId'], reason: 'x' }) },
  'agents.runs.steps': { buildInput: (f) => ({ runId: f['agentRunId'], page: { limit: 50 } }) },
  'agents.runs.approveProposal': {
    buildInput: (f) => ({ runId: f['agentRunId'], stepId: f['agentStepId'], decision: 'accept' }),
  },
  'agents.routingPolicy.get': {
    buildInput: null,
    reason: "no input; reads the caller's own tenant policy (tenant from the verified membership)",
  },
  'agents.routingPolicy.set': {
    buildInput: null,
    reason: "no resource ids; the policy document is stored in the caller's tenant",
  },
};
