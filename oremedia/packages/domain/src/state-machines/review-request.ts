import type { ReviewRequestState } from '@oremedia/contracts/review';
import { defineMachine } from './machine';

export type ReviewRequestEvent = 'package_changed' | 'decide' | 'cancel';

export const reviewRequestMachine = defineMachine<ReviewRequestState, ReviewRequestEvent>({
  name: 'review_request',
  states: ['open', 'stale', 'decided', 'cancelled'],
  events: ['package_changed', 'decide', 'cancel'],
  table: {
    open: { package_changed: 'stale', decide: 'decided', cancel: 'cancelled' },
    stale: { cancel: 'cancelled' },
    decided: {},
    cancelled: {},
  },
  terminal: ['decided', 'cancelled'],
});
