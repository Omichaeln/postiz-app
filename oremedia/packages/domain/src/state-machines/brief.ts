import type { z } from 'zod';
import type { BriefState } from '@oremedia/contracts/content';
import { defineMachine } from './machine';

export type BriefStateValue = z.infer<typeof BriefState>;
export type BriefEvent = 'accept' | 'start' | 'deliver' | 'cancel';

/** Spec 6.3 briefs: draft → accepted → in_progress → delivered; cancellable until delivered. */
export const briefMachine = defineMachine<BriefStateValue, BriefEvent>({
  name: 'brief',
  states: ['draft', 'accepted', 'in_progress', 'delivered', 'cancelled'],
  events: ['accept', 'start', 'deliver', 'cancel'],
  table: {
    draft: { accept: 'accepted', cancel: 'cancelled' },
    accepted: { start: 'in_progress', cancel: 'cancelled' },
    in_progress: { deliver: 'delivered', cancel: 'cancelled' },
    delivered: {},
    cancelled: {},
  },
  terminal: ['delivered', 'cancelled'],
});
