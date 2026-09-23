import type { ApprovalState } from '@oremedia/contracts/approval';
import { defineMachine } from './machine';

export type ApprovalEvent = 'consume' | 'invalidate' | 'expire';

export const approvalMachine = defineMachine<ApprovalState, ApprovalEvent>({
  name: 'approval',
  states: ['valid', 'consumed', 'invalidated', 'expired'],
  events: ['consume', 'invalidate', 'expire'],
  table: {
    valid: { consume: 'consumed', invalidate: 'invalidated', expire: 'expired' },
    consumed: {},
    invalidated: {},
    expired: {},
  },
  terminal: ['consumed', 'invalidated', 'expired'],
});
