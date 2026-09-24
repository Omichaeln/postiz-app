import type { z } from 'zod';
import type { ExperimentState } from '@oremedia/contracts/experiments';
import { defineMachine } from './machine';

export type ExperimentStateValue = z.infer<typeof ExperimentState>;
export type ExperimentEvent = 'pre_register' | 'start' | 'stop' | 'analyse';

/**
 * Spec 16.6: designed → pre_registered (frozen with a hash) → running → stopped → analysed. A running experiment
 * may be analysed directly by a sequential stopping rule; a stopped one is analysed once the window has passed.
 */
export const experimentMachine = defineMachine<ExperimentStateValue, ExperimentEvent>({
  name: 'experiment',
  states: ['designed', 'pre_registered', 'running', 'stopped', 'analysed'],
  events: ['pre_register', 'start', 'stop', 'analyse'],
  table: {
    designed: { pre_register: 'pre_registered' },
    pre_registered: { start: 'running' },
    running: { stop: 'stopped', analyse: 'analysed' },
    stopped: { analyse: 'analysed' },
    analysed: {},
  },
  terminal: ['analysed'],
});
