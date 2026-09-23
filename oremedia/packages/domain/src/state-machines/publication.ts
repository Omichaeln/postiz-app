import type { PublicationState } from '@oremedia/contracts/publishing';
import { defineMachine } from './machine';

/** Spec 13.1 publication transitions (exhaustive; anything else is rejected). */
export type PublicationEvent =
  | 'claim' // workflow claim (fencing token issued)
  | 'user_cancel' // user cancel before claim
  | 'dependency_revoked' // pre-dispatch dependency revocation (fact, asset, approval)
  | 'release_policy_failed' // release policy fails at dispatch
  | 'provider_accepted' // provider accepted synchronously
  | 'provider_pending' // provider returned pending
  | 'provider_rejected' // definitive rejection
  | 'ambiguous_failure' // ambiguous failure after send, or worker loss
  | 'retryable_pre_send' // retryable error proven pre-send (attempt ledger), with backoff
  | 'poll_published' // status polling / finalisation result
  | 'poll_failed'
  | 'poll_unknown'
  | 'reconcile_found' // reconciliation found the remote post
  | 'reconcile_absent' // reconciliation proved absence
  | 'reconcile_exhausted' // reconciliation exhausted; needs a human
  | 'reschedule' // human or policy re-schedules (new attempt, same occurrence)
  | 'hold_resolved_schedule' // human resolves the hold → scheduled
  | 'hold_resolved_cancel'; // human resolves the hold → cancelled

export const publicationMachine = defineMachine<PublicationState, PublicationEvent>({
  name: 'publication',
  states: [
    'scheduled',
    'dispatching',
    'processing',
    'published',
    'failed',
    'outcome_unknown',
    'retry_eligible',
    'cancelled',
    'held',
  ],
  events: [
    'claim',
    'user_cancel',
    'dependency_revoked',
    'release_policy_failed',
    'provider_accepted',
    'provider_pending',
    'provider_rejected',
    'ambiguous_failure',
    'retryable_pre_send',
    'poll_published',
    'poll_failed',
    'poll_unknown',
    'reconcile_found',
    'reconcile_absent',
    'reconcile_exhausted',
    'reschedule',
    'hold_resolved_schedule',
    'hold_resolved_cancel',
  ],
  table: {
    scheduled: { claim: 'dispatching', user_cancel: 'cancelled', dependency_revoked: 'held' },
    dispatching: {
      release_policy_failed: 'held',
      provider_accepted: 'published',
      provider_pending: 'processing',
      provider_rejected: 'failed',
      ambiguous_failure: 'outcome_unknown',
      retryable_pre_send: 'scheduled',
    },
    processing: { poll_published: 'published', poll_failed: 'failed', poll_unknown: 'outcome_unknown' },
    outcome_unknown: {
      reconcile_found: 'published',
      reconcile_absent: 'retry_eligible',
      reconcile_exhausted: 'held',
    },
    retry_eligible: { reschedule: 'scheduled' },
    held: { hold_resolved_schedule: 'scheduled', hold_resolved_cancel: 'cancelled' },
    published: {},
    failed: {},
    cancelled: {},
  },
  terminal: ['published', 'failed', 'cancelled'],
});
