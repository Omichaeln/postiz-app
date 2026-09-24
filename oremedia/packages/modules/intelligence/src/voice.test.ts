import { describe, expect, it } from 'vitest';
import {
  HashingEmbedder,
  cosine,
  labelFor,
  nearestCluster,
  parseClassification,
  updatedCentroid,
} from './voice';

describe('customer voice library (spec 16.5)', () => {
  it("parses the model's one-word class and treats anything else as other", () => {
    expect(parseClassification(' Question.')).toBe('question');
    expect(parseClassification('OBJECTION')).toBe('objection');
    expect(parseClassification('I think this is praise')).toBe('other');
  });

  it('embeds deterministically per tenant: the same text differs across tenants and never lines up', async () => {
    const e = new HashingEmbedder();
    const a = await e.embed('ten_a', 'Do you deliver on weekends?');
    const a2 = await e.embed('ten_a', 'Do you deliver on weekends?');
    const b = await e.embed('ten_b', 'Do you deliver on weekends?');
    expect(a).toEqual(a2);
    expect(cosine(a, a2)).toBeCloseTo(1, 9);
    expect(cosine(a, b)).toBeLessThan(0.6);
    expect(cosine(a, await e.embed('ten_a', 'Weekend delivery, do you do it?'))).toBeGreaterThan(0);
  });

  it('joins the nearest centroid above the threshold and updates it as a running mean', async () => {
    const e = new HashingEmbedder();
    const v1 = await e.embed('t', 'warranty period for the inverter');
    const v2 = await e.embed('t', 'what warranty period does the inverter have');
    const far = await e.embed('t', 'opening hours on public holidays');
    const clusters = [
      { id: 'c1', centroid: v1, size: 1 },
      { id: 'c2', centroid: far, size: 3 },
    ];
    expect(nearestCluster(v2, clusters)?.cluster.id).toBe('c1');
    expect(
      nearestCluster(await e.embed('t', 'completely unrelated words about nothing at all'), clusters),
    ).toBeNull();
    const c = updatedCentroid(v1, 1, v2);
    expect(c).toHaveLength(v1.length);
    expect(Math.sqrt(c.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 9);
  });

  it('labels a cluster from the comment text only', () => {
    expect(labelFor('  Do you   deliver\nto Bulawayo? ')).toBe('Do you deliver to Bulawayo?');
    expect(labelFor('x'.repeat(300))).toHaveLength(200);
  });
});
