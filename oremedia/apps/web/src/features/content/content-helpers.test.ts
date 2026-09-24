import { describe, expect, it } from 'vitest';
import {
  briefChip,
  briefGaps,
  isSuggested,
  missedDate,
  packageWindow,
  parseIds,
  readPackageDocuments,
  revisionChip,
  variantFindings,
} from './content-helpers';

describe('state chips', () => {
  it('labels every revision state of spec 13.1 and names an unknown one', () => {
    expect(revisionChip('in_review').label).toBe('In review');
    expect(revisionChip('changes_requested').label).toBe('Changes requested');
    expect(revisionChip('approved').label).toBe('Approved');
    expect(revisionChip('superseded').label).toBe('Superseded');
    expect(revisionChip('odd').label).toBe('Unknown state (odd)');
  });
  it('says a draft brief is awaiting acceptance', () => {
    expect(briefChip('draft').label).toBe('Awaiting acceptance');
  });
});

describe('planner states (spec 21.2)', () => {
  it('names the gaps of an incomplete brief', () => {
    expect(briefGaps({ audience: ' ', message: 'x', channelConnectionIds: [] })).toEqual([
      'audience',
      'channels',
    ]);
    expect(briefGaps({ audience: 'a', message: 'b', channelConnectionIds: ['cc_1'] })).toEqual([]);
  });
  it('treats an agent or recommendation brief awaiting acceptance as a suggested plan', () => {
    expect(isSuggested({ createdByKind: 'agent', recommendationId: null, state: 'draft' })).toBe(true);
    expect(isSuggested({ createdByKind: 'user', recommendationId: 'rec_1', state: 'draft' })).toBe(true);
    expect(isSuggested({ createdByKind: 'user', recommendationId: null, state: 'draft' })).toBe(false);
    expect(isSuggested({ createdByKind: 'agent', recommendationId: null, state: 'accepted' })).toBe(false);
  });
  it('flags a missed date only for an open campaign past its end', () => {
    const at = new Date('2026-05-10T00:00:00.000Z');
    expect(missedDate({ endsAt: '2026-05-01T00:00:00.000Z', state: 'active' }, at)).toBe(true);
    expect(missedDate({ endsAt: '2026-05-01T00:00:00.000Z', state: 'completed' }, at)).toBe(false);
    expect(missedDate({ endsAt: '2026-06-01T00:00:00.000Z', state: 'draft' }, at)).toBe(false);
  });
});

describe('variantFindings', () => {
  it('reads the stored capability check as data', () => {
    expect(variantFindings({ ok: true, issues: [] })).toEqual({ ok: true, issues: [] });
    expect(
      variantFindings({ ok: false, issues: [{ path: 'text', issue: 'too long' }, { issue: 5 }] }),
    ).toEqual({
      ok: false,
      issues: [{ path: 'text', issue: 'too long' }, { issue: '5' }],
    });
    expect(variantFindings(null)).toEqual({ ok: false, issues: [] });
  });
});

describe('packageWindow, parseIds and device documents', () => {
  it('spans 90 days back to 91 days ahead from the UTC day', () => {
    const w = packageWindow(new Date('2026-03-15T13:45:00.000Z'));
    expect(w.from).toBe('2025-12-15T00:00:00.000Z');
    expect(w.to).toBe('2026-06-14T00:00:00.000Z');
  });
  it('splits, trims and de-duplicates ids', () => {
    expect(parseIds(' doc_a, doc_b\ndoc_a  doc_c ')).toEqual(['doc_a', 'doc_b', 'doc_c']);
    expect(parseIds('')).toEqual([]);
  });
  it('returns nothing when storage is unavailable', () => {
    expect(readPackageDocuments('pkg_1')).toEqual([]);
  });
});
