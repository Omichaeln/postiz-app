import { describe, expect, it } from 'vitest';
import { createClickBuffer, type ClickRow } from './click-buffer';

const row = (n: number): ClickRow => ({
  id: `lc_${n}`,
  tenantId: 'ten_A',
  brandId: 'brd_1',
  trackedLinkId: 'tl_1',
  visitorHash: 'h',
  occurredAt: new Date(),
});

describe('redirector click buffer (spec 15.4: buffered writes)', () => {
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
