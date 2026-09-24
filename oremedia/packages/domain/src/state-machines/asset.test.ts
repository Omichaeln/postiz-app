import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from './machine';
import { assetMachine, uploadIntentMachine, type AssetEvent, type UploadIntentEvent } from './asset';

const ASSET_TABLE: Array<[string, AssetEvent, string]> = [
  ['pending_review', 'approve', 'approved'],
  ['pending_review', 'reject', 'rejected'],
  ['pending_review', 'retire', 'retired'],
  ['approved', 'retire', 'retired'],
];

const INTENT_TABLE: Array<[string, UploadIntentEvent, string]> = [
  ['issued', 'complete', 'uploaded'],
  ['issued', 'expire', 'rejected'],
  ['issued', 'reject', 'rejected'],
  ['uploaded', 'begin_ingest', 'quarantined'],
  ['uploaded', 'reject', 'rejected'],
  ['quarantined', 'accept', 'accepted'],
  ['quarantined', 'reject', 'rejected'],
];

describe('asset state machine (spec 9.1 step 8)', () => {
  it.each(ASSET_TABLE)('%s --%s--> %s', (from, event, to) => {
    expect(assetMachine.transition(from as never, event)).toBe(to);
  });
  it('rejects every transition not in the table; retired and rejected are terminal', () => {
    const allowed = new Set(ASSET_TABLE.map(([f, e]) => `${f}:${e}`));
    for (const s of assetMachine.states)
      for (const e of assetMachine.events) {
        if (allowed.has(`${s}:${e}`)) continue;
        expect(() => assetMachine.transition(s, e)).toThrow(IllegalTransitionError);
      }
    expect(assetMachine.terminal).toEqual(['rejected', 'retired']);
  });
});

describe('upload intent state machine (spec 9.1)', () => {
  it.each(INTENT_TABLE)('%s --%s--> %s', (from, event, to) => {
    expect(uploadIntentMachine.transition(from as never, event)).toBe(to);
  });
  it('rejects every transition not in the table; accepted and rejected are terminal', () => {
    const allowed = new Set(INTENT_TABLE.map(([f, e]) => `${f}:${e}`));
    for (const s of uploadIntentMachine.states)
      for (const e of uploadIntentMachine.events) {
        if (allowed.has(`${s}:${e}`)) continue;
        expect(() => uploadIntentMachine.transition(s, e)).toThrow(IllegalTransitionError);
      }
    expect(uploadIntentMachine.can('accepted', 'reject')).toBe(false);
    expect(uploadIntentMachine.can('issued', 'accept')).toBe(false);
  });
});
