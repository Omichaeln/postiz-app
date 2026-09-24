import { describe, expect, it } from 'vitest';
import {
  ApprovalInvalidatedReason,
  InboxAttention,
  ReviewRequestState,
  StaleReason,
  type FrozenManifestV1,
} from '@oremedia/contracts/review';
import {
  ATTENTION_CHIP,
  INVALIDATED_REASON_TEXT,
  REQUEST_STATE_CHIP,
  STALE_REASON_TEXT,
  invalidatedReasonText,
  manifestChannels,
  orderAttention,
  parsePortalFragment,
  reviewLinkUrl,
  staleReasonText,
  timingText,
} from './review-attention';

describe('attention chips', () => {
  it('covers every inbox attention flag with text', () => {
    for (const flag of InboxAttention.options) {
      expect(ATTENTION_CHIP[flag].label.length).toBeGreaterThan(0);
      expect(ATTENTION_CHIP[flag].detail.length).toBeGreaterThan(0);
    }
    for (const state of ReviewRequestState.options) expect(REQUEST_STATE_CHIP[state].label).toBeTruthy();
  });
  it('orders the flag needing action first and drops unknown ones', () => {
    expect(orderAttention(['approved', 'awaiting_decision', 'stale'])).toEqual([
      'stale',
      'awaiting_decision',
      'approved',
    ]);
  });
});

describe('reason texts', () => {
  it('explains every stale and invalidation reason, and never invents one', () => {
    for (const r of StaleReason.options) expect(STALE_REASON_TEXT[r]).toBeTruthy();
    for (const r of ApprovalInvalidatedReason.options) expect(INVALIDATED_REASON_TEXT[r]).toBeTruthy();
    expect(staleReasonText(null)).toBe('the reason was not recorded');
    expect(invalidatedReasonText('weird')).toBe('the reason was not recorded');
    expect(staleReasonText('variant_changed')).toBe('a channel variant changed');
  });
});

describe('manifest summary', () => {
  const manifest: FrozenManifestV1 = {
    v: 1,
    contentRevisionId: 'cr_1',
    contentHash: 'a'.repeat(64),
    creativeRevisionIds: ['rev_1'],
    exports: [
      { exportId: 'exp_1', contentHash: 'b'.repeat(64), channelConnectionId: 'cc_1' },
      { exportId: 'exp_2', contentHash: 'c'.repeat(64), channelConnectionId: 'cc_1' },
      { exportId: 'exp_3', contentHash: 'd'.repeat(64), channelConnectionId: 'cc_2' },
    ],
    captions: [
      { channelConnectionId: 'cc_1', text: 'Hello', altTexts: ['alt'], settingsHash: 'e'.repeat(64) },
      { channelConnectionId: 'cc_2', text: 'Hi', altTexts: [], settingsHash: 'f'.repeat(64) },
    ],
    timing: { kind: 'exact', at: '2026-09-24T10:00:00.000Z' },
    brandVersionId: 'bv_1',
    policyVersionId: 'pv_1',
  };
  it('groups exports under their caption channel', () => {
    const channels = manifestChannels(manifest);
    expect(channels.map((c) => c.exportCount)).toEqual([2, 1]);
    expect(channels[0]?.text).toBe('Hello');
  });
  it('describes timing kinds', () => {
    expect(timingText(manifest.timing)).toMatch(/^Exactly at /);
    expect(
      timingText({ kind: 'window', from: '2026-09-24T10:00:00.000Z', to: '2026-09-25T10:00:00.000Z' }),
    ).toMatch(/^Between .* and /);
  });
});

describe('portal links', () => {
  it('puts the token in the fragment and reads it back', () => {
    const url = reviewLinkUrl('https://review.example/', 'rr_1', 'rl_abc', '2026-10-01T00:00:00.000Z');
    expect(url).toBe('https://review.example/#request=rr_1&token=rl_abc&exp=2026-10-01T00%3A00%3A00.000Z');
    expect(parsePortalFragment(new URL(url).hash)).toEqual({
      reviewRequestId: 'rr_1',
      token: 'rl_abc',
      expiresAt: '2026-10-01T00:00:00.000Z',
    });
  });
  it('rejects an incomplete link and ignores a bad expiry', () => {
    expect(parsePortalFragment('#rl_only')).toBeNull();
    expect(parsePortalFragment('#request=rr_1&token=ses_notalink')).toBeNull();
    expect(parsePortalFragment('#token=rl_x')).toBeNull();
    expect(parsePortalFragment('')).toBeNull();
    expect(parsePortalFragment('#request=rr_1&token=rl_x&exp=garbage')).toEqual({
      reviewRequestId: 'rr_1',
      token: 'rl_x',
      expiresAt: null,
    });
  });
});
