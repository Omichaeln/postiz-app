import { describe, expect, it } from 'vitest';
import { effectiveAutonomy } from './autonomy';
import { occurrenceKey } from './occurrence';
import { hashText, normaliseText } from './hash';
import { newId } from './ids';

describe('effectiveAutonomy', () => {
  it('is the minimum of all four bounds', () => {
    expect(effectiveAutonomy('managed_autopublish', 'prepare_release', 'create', 'managed_autopublish')).toBe(
      'create',
    );
    expect(
      effectiveAutonomy('assist', 'managed_autopublish', 'managed_autopublish', 'managed_autopublish'),
    ).toBe('assist');
  });
});

describe('occurrenceKey', () => {
  it('is stable and distinguishes deliberate repeats', () => {
    expect(occurrenceKey('pr_1', 'cc_1')).toBe('pr_1:cc_1:once');
    expect(occurrenceKey('pr_1', 'cc_1', 'week-2')).toBe('pr_1:cc_1:week-2');
  });
});

describe('text hashing', () => {
  it('NFC-normalises and trims trailing whitespace only', () => {
    expect(normaliseText('café  \n')).toBe('café');
    expect(hashText('  x ')).toBe(hashText('  x'));
    expect(hashText('x')).not.toBe(hashText(' x'));
  });
});

describe('ids', () => {
  it('generates prefixed 32-char ids', () => {
    const id = newId('publication');
    expect(id).toMatch(/^pub_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.length).toBeLessThanOrEqual(32);
    expect(newId('approvedFact').length).toBeLessThanOrEqual(32);
  });
  it('ids minted in one burst sort in creation order (lists ordered by id keep insertion order)', () => {
    const ids = Array.from({ length: 2000 }, () => newId('experimentVariant'));
    expect([...ids].sort()).toEqual(ids);
  });
});
