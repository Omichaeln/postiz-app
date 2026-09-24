import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from './machine';
import { skillVersionMachine, type SkillVersionEvent } from './skill-version';

/** Spec 10.2, exhaustively. */
const TABLE: Array<[string, SkillVersionEvent, string]> = [
  ['draft', 'start_evaluation', 'sandbox_evaluation'],
  ['draft', 'retire', 'retired'],
  ['sandbox_evaluation', 'evaluation_passed', 'in_review'],
  ['sandbox_evaluation', 'evaluation_failed', 'draft'],
  ['in_review', 'publish', 'published'],
  ['in_review', 'reject', 'draft'],
  ['in_review', 'retire', 'retired'],
  ['published', 'retire', 'retired'],
];

describe('skill version state machine (spec 10.2)', () => {
  it.each(TABLE)('%s --%s--> %s', (from, event, to) => {
    expect(skillVersionMachine.transition(from as never, event)).toBe(to);
  });
  it('rejects every transition not in the table; retired is terminal', () => {
    const allowed = new Set(TABLE.map(([f, e]) => `${f}:${e}`));
    let rejected = 0;
    for (const s of skillVersionMachine.states)
      for (const e of skillVersionMachine.events) {
        if (allowed.has(`${s}:${e}`)) continue;
        expect(() => skillVersionMachine.transition(s, e)).toThrow(IllegalTransitionError);
        rejected++;
      }
    expect(rejected).toBe(
      skillVersionMachine.states.length * skillVersionMachine.events.length - TABLE.length,
    );
    expect(skillVersionMachine.terminal).toEqual(['retired']);
    for (const e of skillVersionMachine.events) expect(skillVersionMachine.can('retired', e)).toBe(false);
  });
  it('a draft cannot be published without evaluation and review; a failed evaluation goes back to draft', () => {
    expect(skillVersionMachine.can('draft', 'publish')).toBe(false);
    expect(skillVersionMachine.can('sandbox_evaluation', 'publish')).toBe(false);
    expect(skillVersionMachine.next('sandbox_evaluation', 'evaluation_failed')).toBe('draft');
    expect(skillVersionMachine.can('sandbox_evaluation', 'retire')).toBe(false);
  });
});
