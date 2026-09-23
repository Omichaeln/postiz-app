import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from './machine';
import { publicationMachine, type PublicationEvent } from './publication';
import { contentRevisionMachine } from './content-revision';
import { renderJobMachine } from './render-job';
import { agentRunMachine } from './agent-run';
import { approvalMachine } from './approval';
import { brandVersionMachine } from './brand-version';
import { reviewRequestMachine } from './review-request';

/** Spec 13.1: the publication transition table, exhaustively. */
const PUBLICATION_TABLE: Array<[string, PublicationEvent, string]> = [
  ['scheduled', 'claim', 'dispatching'],
  ['scheduled', 'user_cancel', 'cancelled'],
  ['scheduled', 'dependency_revoked', 'held'],
  ['dispatching', 'release_policy_failed', 'held'],
  ['dispatching', 'provider_accepted', 'published'],
  ['dispatching', 'provider_pending', 'processing'],
  ['dispatching', 'provider_rejected', 'failed'],
  ['dispatching', 'ambiguous_failure', 'outcome_unknown'],
  ['dispatching', 'retryable_pre_send', 'scheduled'],
  ['processing', 'poll_published', 'published'],
  ['processing', 'poll_failed', 'failed'],
  ['processing', 'poll_unknown', 'outcome_unknown'],
  ['outcome_unknown', 'reconcile_found', 'published'],
  ['outcome_unknown', 'reconcile_absent', 'retry_eligible'],
  ['outcome_unknown', 'reconcile_exhausted', 'held'],
  ['retry_eligible', 'reschedule', 'scheduled'],
  ['held', 'hold_resolved_schedule', 'scheduled'],
  ['held', 'hold_resolved_cancel', 'cancelled'],
];

describe('publication state machine', () => {
  it.each(PUBLICATION_TABLE)('%s --%s--> %s', (from, event, to) => {
    expect(publicationMachine.transition(from as never, event)).toBe(to);
  });
  it('rejects every transition not in the table', () => {
    const allowed = new Set(PUBLICATION_TABLE.map(([f, e]) => `${f}:${e}`));
    let rejected = 0;
    for (const s of publicationMachine.states) {
      for (const e of publicationMachine.events) {
        if (allowed.has(`${s}:${e}`)) continue;
        expect(() => publicationMachine.transition(s, e)).toThrow(IllegalTransitionError);
        rejected++;
      }
    }
    expect(rejected).toBe(
      publicationMachine.states.length * publicationMachine.events.length - PUBLICATION_TABLE.length,
    );
  });
  it('published, failed and cancelled are terminal', () => {
    for (const s of ['published', 'failed', 'cancelled'] as const) {
      for (const e of publicationMachine.events) expect(publicationMachine.can(s, e)).toBe(false);
    }
  });
  it('outcome_unknown never transitions by a retry event', () => {
    expect(publicationMachine.can('outcome_unknown', 'retryable_pre_send')).toBe(false);
    expect(publicationMachine.can('outcome_unknown', 'reschedule')).toBe(false);
  });
});

describe('other machines', () => {
  it('content revision: draft → in_review → approved → superseded; approved cannot be edited back', () => {
    expect(contentRevisionMachine.transition('draft', 'request_review')).toBe('in_review');
    expect(contentRevisionMachine.transition('in_review', 'approve')).toBe('approved');
    expect(contentRevisionMachine.transition('approved', 'supersede')).toBe('superseded');
    expect(contentRevisionMachine.can('approved', 'reopen')).toBe(false);
    expect(contentRevisionMachine.can('approved', 'request_review')).toBe(false);
  });
  it('render job: pending → rendering → ready | failed → retry', () => {
    expect(renderJobMachine.transition('pending', 'start')).toBe('rendering');
    expect(renderJobMachine.transition('rendering', 'fail')).toBe('failed');
    expect(renderJobMachine.transition('failed', 'retry')).toBe('pending');
    expect(renderJobMachine.can('ready', 'retry')).toBe(false);
  });
  it('agent run: waiting_for_review expires or resumes; terminal states are final', () => {
    expect(agentRunMachine.transition('running', 'await_review')).toBe('waiting_for_review');
    expect(agentRunMachine.transition('waiting_for_review', 'waiting_expired')).toBe('waiting_expired');
    expect(agentRunMachine.transition('waiting_for_review', 'review_decided')).toBe('running');
    for (const s of agentRunMachine.terminal)
      for (const e of agentRunMachine.events) expect(agentRunMachine.can(s, e)).toBe(false);
  });
  it('approval: valid → consumed | invalidated | expired, never back', () => {
    expect(approvalMachine.transition('valid', 'invalidate')).toBe('invalidated');
    expect(approvalMachine.can('invalidated', 'consume')).toBe(false);
    expect(approvalMachine.can('consumed', 'invalidate')).toBe(false);
  });
  it('brand version: exactly the spec lifecycle', () => {
    expect(brandVersionMachine.transition('draft', 'submit')).toBe('in_review');
    expect(brandVersionMachine.transition('in_review', 'publish')).toBe('published');
    expect(brandVersionMachine.transition('published', 'retire')).toBe('retired');
    expect(brandVersionMachine.can('published', 'submit')).toBe(false);
  });
  it('review request: open → stale on package change; stale cannot be decided', () => {
    expect(reviewRequestMachine.transition('open', 'package_changed')).toBe('stale');
    expect(reviewRequestMachine.can('stale', 'decide')).toBe(false);
  });
});
