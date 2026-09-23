import { describe, expect, it } from 'vitest';
import { bindingHash, withinTiming, type ApprovalBindingV1 } from './approval-binding';

const base: ApprovalBindingV1 = {
  v: 1,
  tenantId: 'ten_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  brandId: 'brd_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  contentRevisionId: 'pr_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  brandVersionId: 'bv_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  policyVersionId: 'pol_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  targets: [
    {
      channelConnectionId: 'cc_1',
      textHash: 'a'.repeat(64),
      altTextHashes: [],
      settingsHash: 'b'.repeat(64),
      exportHashes: ['c'.repeat(64)],
    },
  ],
  timing: { kind: 'exact', at: '2026-10-01T09:00:00.000Z' },
};

describe('bindingHash', () => {
  it('is deterministic and independent of key order', () => {
    const reordered = {
      timing: base.timing,
      targets: base.targets,
      v: 1 as const,
      policyVersionId: base.policyVersionId,
      brandVersionId: base.brandVersionId,
      contentRevisionId: base.contentRevisionId,
      brandId: base.brandId,
      tenantId: base.tenantId,
    };
    expect(bindingHash(base)).toBe(bindingHash(reordered));
    expect(bindingHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when any bound field changes', () => {
    const h = bindingHash(base);
    expect(bindingHash({ ...base, targets: [{ ...base.targets[0]!, textHash: 'd'.repeat(64) }] })).not.toBe(
      h,
    );
    expect(
      bindingHash({ ...base, targets: [{ ...base.targets[0]!, exportHashes: ['e'.repeat(64)] }] }),
    ).not.toBe(h);
    expect(bindingHash({ ...base, brandVersionId: 'bv_other' })).not.toBe(h);
    expect(bindingHash({ ...base, policyVersionId: 'pol_other' })).not.toBe(h);
    expect(bindingHash({ ...base, timing: { kind: 'exact', at: '2026-10-01T09:01:00.000Z' } })).not.toBe(h);
    expect(
      bindingHash({ ...base, targets: [{ ...base.targets[0]!, channelConnectionId: 'cc_2' }] }),
    ).not.toBe(h);
  });
  it('rejects a malformed binding', () => {
    expect(() => bindingHash({ ...base, targets: [] })).toThrow();
  });
  it('fixture: known hash for the base binding', () => {
    // Pinned so that any drift in canonicalisation or hashing is caught (spec 13.2: one implementation, tested with fixtures).
    expect(bindingHash(base)).toBe('516c8e8667914cef3c9a969d392c8d38e9b2eb751ac255eeb571f29121a7b794');
  });
});

describe('withinTiming', () => {
  it('exact timing allows ±15 minutes by default', () => {
    expect(
      withinTiming({ kind: 'exact', at: '2026-10-01T09:00:00.000Z' }, new Date('2026-10-01T09:10:00.000Z')),
    ).toBe(true);
    expect(
      withinTiming({ kind: 'exact', at: '2026-10-01T09:00:00.000Z' }, new Date('2026-10-01T09:20:00.000Z')),
    ).toBe(false);
  });
  it('window timing is inclusive', () => {
    const t = { kind: 'window' as const, from: '2026-10-01T09:00:00.000Z', to: '2026-10-01T10:00:00.000Z' };
    expect(withinTiming(t, new Date('2026-10-01T09:00:00.000Z'))).toBe(true);
    expect(withinTiming(t, new Date('2026-10-01T10:00:00.000Z'))).toBe(true);
    expect(withinTiming(t, new Date('2026-10-01T10:00:00.001Z'))).toBe(false);
  });
});
