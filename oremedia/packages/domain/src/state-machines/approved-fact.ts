import type { FactState } from '@oremedia/contracts/brand';
import { defineMachine } from './machine';

export type ApprovedFactEvent = 'approve' | 'revoke';

/** Spec 8.2: proposed → approved → revoked. A proposal can also be withdrawn (revoked) before approval. */
export const approvedFactMachine = defineMachine<FactState, ApprovedFactEvent>({
  name: 'approved_fact',
  states: ['proposed', 'approved', 'revoked'],
  events: ['approve', 'revoke'],
  table: {
    proposed: { approve: 'approved', revoke: 'revoked' },
    approved: { revoke: 'revoked' },
    revoked: {},
  },
  terminal: ['revoked'],
});
