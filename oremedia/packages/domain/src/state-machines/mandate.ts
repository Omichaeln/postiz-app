import type { z } from 'zod';
import type { MandateState } from '@oremedia/contracts/publishing';
import { defineMachine } from './machine';

export type MandateStateValue = z.infer<typeof MandateState>;
export type MandateEvent = 'pause' | 'resume' | 'revoke' | 'expire';

/** Spec 6.3 publishing_mandates: mandates always expire; revoked and expired are final. */
export const mandateMachine = defineMachine<MandateStateValue, MandateEvent>({
  name: 'mandate',
  states: ['active', 'paused', 'revoked', 'expired'],
  events: ['pause', 'resume', 'revoke', 'expire'],
  table: {
    active: { pause: 'paused', revoke: 'revoked', expire: 'expired' },
    paused: { resume: 'active', revoke: 'revoked', expire: 'expired' },
    revoked: {},
    expired: {},
  },
  terminal: ['revoked', 'expired'],
});
