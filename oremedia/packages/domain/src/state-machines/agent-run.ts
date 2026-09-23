import type { AgentRunState } from '@oremedia/contracts/agents';
import { defineMachine } from './machine';

export type AgentRunEvent =
  | 'start'
  | 'await_review'
  | 'review_decided'
  | 'complete'
  | 'fail'
  | 'cancel'
  | 'budget_exhausted'
  | 'policy_denied'
  | 'waiting_expired';

export const agentRunMachine = defineMachine<AgentRunState, AgentRunEvent>({
  name: 'agent_run',
  states: [
    'planned',
    'running',
    'waiting_for_review',
    'completed',
    'failed',
    'cancelled',
    'budget_exhausted',
    'policy_denied',
    'waiting_expired',
  ],
  events: [
    'start',
    'await_review',
    'review_decided',
    'complete',
    'fail',
    'cancel',
    'budget_exhausted',
    'policy_denied',
    'waiting_expired',
  ],
  table: {
    planned: {
      start: 'running',
      cancel: 'cancelled',
      fail: 'failed',
      policy_denied: 'policy_denied',
      budget_exhausted: 'budget_exhausted',
    },
    running: {
      await_review: 'waiting_for_review',
      complete: 'completed',
      fail: 'failed',
      cancel: 'cancelled',
      budget_exhausted: 'budget_exhausted',
      policy_denied: 'policy_denied',
    },
    waiting_for_review: {
      review_decided: 'running',
      cancel: 'cancelled',
      waiting_expired: 'waiting_expired',
      fail: 'failed',
    },
    completed: {},
    failed: {},
    cancelled: {},
    budget_exhausted: {},
    policy_denied: {},
    waiting_expired: {},
  },
  terminal: ['completed', 'failed', 'cancelled', 'budget_exhausted', 'policy_denied', 'waiting_expired'],
});
