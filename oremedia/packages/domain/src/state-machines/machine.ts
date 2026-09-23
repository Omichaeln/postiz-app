/**
 * Spec 13.1: status is never written by setting a string; it is written by transition(entity, event),
 * which rejects illegal moves. Every machine is a pure transition table with exhaustive tests.
 */
export class IllegalTransitionError extends Error {
  readonly machine: string;
  readonly from: string;
  readonly event: string;
  constructor(machine: string, from: string, event: string) {
    super(`${machine}: illegal transition from '${from}' on '${event}'`);
    this.name = 'IllegalTransitionError';
    this.machine = machine;
    this.from = from;
    this.event = event;
  }
}

export interface StateMachine<S extends string, E extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly table: Readonly<Record<S, Partial<Record<E, S>>>>;
  readonly terminal: readonly S[];
  transition(from: S, event: E): S;
  can(from: S, event: E): boolean;
  next(from: S, event: E): S | null;
}

export function defineMachine<S extends string, E extends string>(def: {
  name: string;
  states: readonly S[];
  events: readonly E[];
  table: Readonly<Record<S, Partial<Record<E, S>>>>;
  terminal?: readonly S[];
}): StateMachine<S, E> {
  const terminal = def.terminal ?? [];
  const next = (from: S, event: E): S | null => {
    const row = def.table[from];
    const to = row?.[event];
    return to === undefined ? null : to;
  };
  return {
    name: def.name,
    states: def.states,
    events: def.events,
    table: def.table,
    terminal,
    next,
    can: (from, event) => next(from, event) !== null,
    transition: (from, event) => {
      const to = next(from, event);
      if (to === null) throw new IllegalTransitionError(def.name, from, event);
      return to;
    },
  };
}
