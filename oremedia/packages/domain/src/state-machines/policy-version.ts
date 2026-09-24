import type { PolicyVersionState } from '@oremedia/contracts/brand';
import { defineMachine } from './machine';

export type PolicyVersionEvent = 'activate' | 'retire';

/** Spec 6.3 policy_versions: draft → active → retired; exactly one active per brand (activation retires the previous). */
export const policyVersionMachine = defineMachine<PolicyVersionState, PolicyVersionEvent>({
  name: 'policy_version',
  states: ['draft', 'active', 'retired'],
  events: ['activate', 'retire'],
  table: {
    draft: { activate: 'active', retire: 'retired' },
    active: { retire: 'retired' },
    retired: {},
  },
  terminal: ['retired'],
});
