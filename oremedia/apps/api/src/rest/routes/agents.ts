import type { RestRouteSpec } from '../route';

/** Spec 7.6 agent runs (spec 12.2): start through the outbox, read state and steps. */
export const AGENT_ROUTES: readonly RestRouteSpec[] = [
  {
    method: 'POST',
    path: '/v1/agent-runs',
    procedure: 'agents.runs.start',
    summary: 'Start an agent run',
    successStatus: 201,
  },
  { method: 'GET', path: '/v1/agent-runs/:runId', procedure: 'agents.runs.get', summary: 'Get an agent run' },
  {
    method: 'GET',
    path: '/v1/agent-runs/:runId/steps',
    procedure: 'agents.runs.steps',
    summary: 'List the steps of an agent run',
  },
];
