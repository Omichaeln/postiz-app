import type { ContentRevisionState } from '@oremedia/contracts/review';
import { defineMachine } from './machine';

export type ContentRevisionEvent = 'request_review' | 'request_changes' | 'approve' | 'supersede' | 'reopen';

export const contentRevisionMachine = defineMachine<ContentRevisionState, ContentRevisionEvent>({
  name: 'content_revision',
  states: ['draft', 'in_review', 'changes_requested', 'approved', 'superseded'],
  events: ['request_review', 'request_changes', 'approve', 'supersede', 'reopen'],
  table: {
    draft: { request_review: 'in_review', supersede: 'superseded' },
    in_review: { request_changes: 'changes_requested', approve: 'approved', supersede: 'superseded' },
    changes_requested: { request_review: 'in_review', reopen: 'draft', supersede: 'superseded' },
    approved: { supersede: 'superseded' },
    superseded: {},
  },
  terminal: ['superseded'],
});
