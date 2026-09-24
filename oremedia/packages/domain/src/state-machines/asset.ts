import type { AssetState, UploadIntentState } from '@oremedia/contracts/assets';
import { defineMachine } from './machine';

export type AssetEvent = 'approve' | 'reject' | 'retire';

/** Spec 9.1 step 8 / 7.5: pending_review → approved | rejected; approved → retired. Retired is terminal. */
export const assetMachine = defineMachine<AssetState, AssetEvent>({
  name: 'asset',
  states: ['pending_review', 'approved', 'rejected', 'retired'],
  events: ['approve', 'reject', 'retire'],
  table: {
    pending_review: { approve: 'approved', reject: 'rejected', retire: 'retired' },
    approved: { retire: 'retired' },
    rejected: {},
    retired: {},
  },
  terminal: ['rejected', 'retired'],
});

export type UploadIntentEvent = 'complete' | 'begin_ingest' | 'accept' | 'reject' | 'expire';

/**
 * Spec 9.1: issued → uploaded (client completed) → quarantined (ingest running) → accepted | rejected.
 * An issued intent that is never completed expires (rejected); a quarantined one may be rejected by any step.
 */
export const uploadIntentMachine = defineMachine<UploadIntentState, UploadIntentEvent>({
  name: 'upload_intent',
  states: ['issued', 'uploaded', 'quarantined', 'accepted', 'rejected'],
  events: ['complete', 'begin_ingest', 'accept', 'reject', 'expire'],
  table: {
    issued: { complete: 'uploaded', expire: 'rejected', reject: 'rejected' },
    uploaded: { begin_ingest: 'quarantined', reject: 'rejected' },
    quarantined: { accept: 'accepted', reject: 'rejected' },
    accepted: {},
    rejected: {},
  },
  terminal: ['accepted', 'rejected'],
});
