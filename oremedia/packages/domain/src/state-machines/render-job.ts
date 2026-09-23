import type { RenderJobState } from '@oremedia/contracts/creative';
import { defineMachine } from './machine';

export type RenderJobEvent = 'start' | 'succeed' | 'fail' | 'retry';

export const renderJobMachine = defineMachine<RenderJobState, RenderJobEvent>({
  name: 'render_job',
  states: ['pending', 'rendering', 'ready', 'failed'],
  events: ['start', 'succeed', 'fail', 'retry'],
  table: {
    pending: { start: 'rendering' },
    rendering: { succeed: 'ready', fail: 'failed' },
    failed: { retry: 'pending' },
    ready: {},
  },
  terminal: ['ready'],
});
