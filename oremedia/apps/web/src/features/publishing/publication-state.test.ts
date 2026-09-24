import { describe, expect, it } from 'vitest';
import { PublicationState } from '@oremedia/contracts/publishing';
import { RELEASE_CHECK_KEYS } from '@oremedia/contracts/review';
import {
  actionsFor,
  channelOutcomeSummary,
  dayKey,
  groupByDay,
  holdReasonText,
  localMidnight,
  monthGrid,
  publicationChip,
  rangeFor,
  shiftAnchor,
  weekDays,
  PUBLICATION_CHIP,
  HOLD_REASON_TEXT,
} from './publication-state';

describe('publicationChip', () => {
  it('maps every publication state to a chip with text and a tone', () => {
    for (const state of PublicationState.options) {
      const chip = publicationChip(state);
      expect(chip.label.length).toBeGreaterThan(0);
      expect(chip.detail.length).toBeGreaterThan(0);
      expect(chip).toBe(PUBLICATION_CHIP[state]);
    }
  });
  it('names an unknown state instead of guessing', () => {
    expect(publicationChip('exploded').label).toBe('Unknown state (exploded)');
    expect(publicationChip('exploded').tone).toBe('neutral');
  });
  it('explains outcome_unknown and marks it as needing attention', () => {
    expect(PUBLICATION_CHIP.outcome_unknown.tone).toBe('warning');
    expect(PUBLICATION_CHIP.outcome_unknown.detail).toContain('reconciled');
  });
});

describe('holdReasonText', () => {
  it('has text for every release check key of spec 13.4', () => {
    for (const key of RELEASE_CHECK_KEYS) expect(HOLD_REASON_TEXT[key]).toBeTruthy();
  });
  it('never invents an explanation for an unknown key', () => {
    expect(holdReasonText('something_new')).toBe('No explanation is recorded for this reason.');
  });
});

describe('actionsFor', () => {
  it('follows the spec 13.1 transition table', () => {
    expect(actionsFor('scheduled')).toMatchObject({ cancel: true, reschedule: true, cancelInFlight: false });
    expect(actionsFor('dispatching')).toMatchObject({
      cancel: true,
      cancelInFlight: true,
      reschedule: false,
    });
    expect(actionsFor('outcome_unknown')).toMatchObject({ reconcile: true, cancelInFlight: true });
    expect(actionsFor('held')).toMatchObject({ cancel: true, release: true, reconcile: true });
    expect(actionsFor('retry_eligible')).toMatchObject({ release: true, cancel: false });
    expect(actionsFor('published')).toMatchObject({ cancel: false, deleteRemote: true });
    expect(actionsFor('failed')).toMatchObject({ cancel: false, reschedule: false, release: false });
    expect(actionsFor('cancelled')).toMatchObject({ cancel: false, reschedule: false });
  });
});

describe('calendar grouping', () => {
  it('keys days in the brand time zone', () => {
    expect(dayKey('2026-09-24T23:30:00.000Z', 'UTC')).toBe('2026-09-24');
    expect(dayKey('2026-09-24T23:30:00.000Z', 'Europe/Berlin')).toBe('2026-09-25');
    expect(dayKey('2026-09-24T02:30:00.000Z', 'America/Los_Angeles')).toBe('2026-09-23');
  });
  it('groups by day and orders each day by time', () => {
    const grouped = groupByDay(
      [
        { id: 'b', scheduledFor: '2026-09-24T10:00:00.000Z' },
        { id: 'a', scheduledFor: '2026-09-24T08:00:00.000Z' },
        { id: 'c', scheduledFor: '2026-09-25T08:00:00.000Z' },
      ],
      'UTC',
    );
    expect([...grouped.keys()]).toEqual(['2026-09-24', '2026-09-25']);
    expect(grouped.get('2026-09-24')?.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('calendar grids', () => {
  it('draws six Monday-first weeks around the month', () => {
    const grid = monthGrid('2026-09-15');
    expect(grid).toHaveLength(42);
    expect(grid[0]?.key).toBe('2026-08-31'); // Monday before 1 September 2026 (a Tuesday)
    expect(grid[0]?.inMonth).toBe(false);
    expect(grid[1]?.key).toBe('2026-09-01');
    expect(grid[1]?.inMonth).toBe(true);
    expect(grid.filter((d) => d.inMonth)).toHaveLength(30);
  });
  it('draws the week containing the anchor', () => {
    const week = weekDays('2026-09-24'); // Thursday
    expect(week.map((d) => d.key)).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ]);
  });
  it('shifts by a month or a week', () => {
    expect(shiftAnchor('2026-01-31', 'month', 1)).toBe('2026-02-01');
    expect(shiftAnchor('2026-03-01', 'month', -1)).toBe('2026-02-01');
    expect(shiftAnchor('2026-09-24', 'week', 1)).toBe('2026-10-01');
  });
  it('computes local midnight in a zone', () => {
    expect(localMidnight('2026-09-24', 'UTC').toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(localMidnight('2026-09-24', 'Europe/Berlin').toISOString()).toBe('2026-09-23T22:00:00.000Z');
    expect(localMidnight('2026-09-24', 'America/Los_Angeles').toISOString()).toBe('2026-09-24T07:00:00.000Z');
  });
  it('covers the whole grid in the range request', () => {
    const r = rangeFor('week', '2026-09-24', 'UTC');
    expect(r.from).toBe('2026-09-21T00:00:00.000Z');
    expect(r.to).toBe('2026-09-27T23:59:59.999Z');
  });
});

describe('channelOutcomeSummary', () => {
  it('names every non-success and flags partial success (spec 14.4)', () => {
    const s = channelOutcomeSummary([{ state: 'published' }, { state: 'failed' }, { state: 'held' }]);
    expect(s.partial).toBe(true);
    expect(s.text).toBe('1 published, 1 failed, 1 held of 3 channels.');
  });
  it('is not partial when everything published or nothing did', () => {
    expect(channelOutcomeSummary([{ state: 'published' }, { state: 'published' }]).partial).toBe(false);
    expect(channelOutcomeSummary([{ state: 'failed' }]).partial).toBe(false);
    expect(channelOutcomeSummary([]).text).toBe('No channels.');
  });
  it('does not count a cancelled channel against success', () => {
    expect(channelOutcomeSummary([{ state: 'published' }, { state: 'cancelled' }]).partial).toBe(false);
  });
});
