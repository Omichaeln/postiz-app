import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from './machine';
import {
  templateMachine,
  templateVersionMachine,
  type TemplateEvent,
  type TemplateVersionEvent,
} from './template-version';

const VERSION_TABLE: Array<[string, TemplateVersionEvent, string]> = [
  ['draft', 'approve', 'approved'],
  ['draft', 'retire', 'retired'],
  ['approved', 'retire', 'retired'],
];

const TEMPLATE_TABLE: Array<[string, TemplateEvent, string]> = [
  ['draft', 'activate', 'active'],
  ['draft', 'retire', 'retired'],
  ['active', 'retire', 'retired'],
];

describe('template version state machine (spec 6.3)', () => {
  it.each(VERSION_TABLE)('%s --%s--> %s', (from, event, to) => {
    expect(templateVersionMachine.transition(from as never, event)).toBe(to);
  });
  it('rejects every transition not in the table; retired is terminal', () => {
    const allowed = new Set(VERSION_TABLE.map(([f, e]) => `${f}:${e}`));
    let rejected = 0;
    for (const s of templateVersionMachine.states)
      for (const e of templateVersionMachine.events) {
        if (allowed.has(`${s}:${e}`)) continue;
        expect(() => templateVersionMachine.transition(s, e)).toThrow(IllegalTransitionError);
        rejected++;
      }
    expect(rejected).toBe(
      templateVersionMachine.states.length * templateVersionMachine.events.length - VERSION_TABLE.length,
    );
    expect(templateVersionMachine.can('approved', 'approve')).toBe(false);
    expect(templateVersionMachine.terminal).toEqual(['retired']);
  });
});

describe('template state machine (spec 6.3)', () => {
  it.each(TEMPLATE_TABLE)('%s --%s--> %s', (from, event, to) => {
    expect(templateMachine.transition(from as never, event)).toBe(to);
  });
  it('rejects every transition not in the table; retired is terminal', () => {
    const allowed = new Set(TEMPLATE_TABLE.map(([f, e]) => `${f}:${e}`));
    for (const s of templateMachine.states)
      for (const e of templateMachine.events) {
        if (allowed.has(`${s}:${e}`)) continue;
        expect(() => templateMachine.transition(s, e)).toThrow(IllegalTransitionError);
      }
    expect(templateMachine.can('active', 'activate')).toBe(false);
    for (const e of templateMachine.events) expect(templateMachine.can('retired', e)).toBe(false);
  });
});
