import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from './machine';
import { deletionRequestMachine } from './deletion-request';

describe('deletion request machine (spec 17.5)', () => {
  it('requested → in_progress → completed, or → blocked (operator) → completed / resumed', () => {
    expect(deletionRequestMachine.transition('requested', 'begin')).toBe('in_progress');
    expect(deletionRequestMachine.transition('in_progress', 'complete')).toBe('completed');
    expect(deletionRequestMachine.transition('in_progress', 'await_operator')).toBe('blocked');
    expect(deletionRequestMachine.transition('blocked', 'complete')).toBe('completed');
    expect(deletionRequestMachine.transition('blocked', 'resume')).toBe('in_progress');
  });
  it('only a restore re-application leaves completed; a request cannot skip the fan-out', () => {
    const out = deletionRequestMachine.events.filter((e) => deletionRequestMachine.can('completed', e));
    expect(out).toEqual(['reapply']);
    expect(deletionRequestMachine.transition('completed', 'reapply')).toBe('in_progress');
    expect(deletionRequestMachine.transition('blocked', 'reapply')).toBe('in_progress');
    expect(() => deletionRequestMachine.transition('requested', 'complete')).toThrow(IllegalTransitionError);
    expect(() => deletionRequestMachine.transition('requested', 'reapply')).toThrow(IllegalTransitionError);
  });
});
