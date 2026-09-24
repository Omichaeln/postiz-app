import { describe, expect, it } from 'vitest';
import { createClickBuffer, visitorHash, type ClickRow } from './click-buffer';

const row = (n: number): ClickRow => ({
  id: `lc_${n}`,
  tenantId: 'ten_A',
  brandId: 'brd_1',
  trackedLinkId: 'tl_1',
  visitorHash: 'h',
  occurredAt: new Date(),
});

describe('redirector click buffer (spec 15.4: buffered writes, hashed visitor)', () => {
  it('hashes the visitor with a daily salt: stable within a day, different across days and secrets', () => {
    const d1 = new Date('2026-09-24T10:00:00Z');
    const a = visitorHash('secret', '203.0.113.5', 'UA', d1);
    expect(a).toBe(visitorHash('secret', '203.0.113.5', 'UA', new Date('2026-09-24T23:00:00Z')));
    expect(a).not.toBe(visitorHash('secret', '203.0.113.5', 'UA', new Date('2026-09-25T00:00:00Z')));
    expect(a).not.toBe(visitorHash('other', '203.0.113.5', 'UA', d1));
    expect(a).not.toContain('203.0.113.5');
  });
  it('flushes in batches, keeps the batch on a failed write and drains on stop', async () => {
    const written: ClickRow[][] = [];
    let fail = true;
    const buffer = createClickBuffer({
      maxBatch: 2,
      write: async (rows) => {
        if (fail) throw new Error('db down');
        written.push(rows);
      },
    });
    for (let i = 0; i < 3; i++) buffer.add(row(i));
    await buffer.flush();
    expect(buffer.size()).toBe(3); // nothing lost on failure
    fail = false;
    await buffer.stop();
    expect(written.map((b) => b.length)).toEqual([2, 1]);
    expect(buffer.size()).toBe(0);
  });
  it('drops beyond the memory bound instead of growing without limit', () => {
    const buffer = createClickBuffer({ maxBuffered: 2, write: async () => undefined });
    for (let i = 0; i < 5; i++) buffer.add(row(i));
    expect(buffer.size()).toBe(2);
  });
});
