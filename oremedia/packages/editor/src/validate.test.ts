import { describe, expect, it } from 'vitest';
import { reduce } from './reduce';
import { contrastRatio, validateAgainstBrand } from './validate';
import { fixtureDocument, fixtureSnapshot, ids } from './fixtures';

const P = 'page_1';
const codes = (f: ReturnType<typeof validateAgainstBrand>) => f.map((x) => `${x.severity}:${x.code}`);

describe('validateAgainstBrand (spec 11.4)', () => {
  it('the fixture document is clean', () => {
    expect(
      validateAgainstBrand(fixtureDocument(), fixtureSnapshot()).filter((f) => f.severity === 'blocking'),
    ).toEqual([]);
  });
  it('flags text below the brand minimum size and unknown tokens', () => {
    const doc = reduce(fixtureDocument(), {
      op: 'setStyle',
      pageId: P,
      elementId: ids.body,
      patch: { sizePx: 12, colourToken: 'nope' },
    });
    const c = codes(validateAgainstBrand(doc, fixtureSnapshot()));
    expect(c).toContain('blocking:min_size');
    expect(c).toContain('blocking:unknown_colour_token');
  });
  it('raw colour values are warnings; low contrast is blocking', () => {
    const doc = reduce(fixtureDocument(), {
      op: 'setStyle',
      pageId: P,
      elementId: ids.body,
      patch: { colourToken: undefined, colourValue: '#E0E4E0' },
    });
    const c = codes(validateAgainstBrand(doc, fixtureSnapshot()));
    expect(c).toContain('warning:raw_colour');
    expect(c).toContain('blocking:contrast');
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    expect(contrastRatio('#172120', '#F4F6F3')).toBeGreaterThan(12);
  });
  it('unapproved facts and prohibited phrases are blocking', () => {
    const doc = reduce(fixtureDocument(), {
      op: 'setText',
      pageId: P,
      elementId: ids.body,
      text: 'Cheap deal',
      factRefs: ['fact_9'],
    });
    const c = codes(validateAgainstBrand(doc, fixtureSnapshot()));
    expect(c).toContain('blocking:unknown_fact');
    expect(c).toContain('blocking:prohibited_phrase');
  });
  it('logo rules: minimum width, allowed background, clear space, rotation', () => {
    let doc = reduce(fixtureDocument(), {
      op: 'resizeElement',
      pageId: P,
      elementId: ids.logo,
      width: 100,
      height: 30,
    });
    expect(codes(validateAgainstBrand(doc, fixtureSnapshot()))).toContain('blocking:logo_min_width');
    doc = reduce(fixtureDocument(), {
      op: 'setStyle',
      pageId: P,
      elementId: ids.bg,
      patch: { fillToken: 'accent' },
    });
    expect(codes(validateAgainstBrand(doc, fixtureSnapshot()))).toContain('blocking:logo_background');
    doc = reduce(fixtureDocument(), { op: 'moveElement', pageId: P, elementId: ids.body, x: 80, y: 880 });
    expect(codes(validateAgainstBrand(doc, fixtureSnapshot()))).toContain('blocking:logo_clear_space');
  });
  it('elements leaving the safe area are flagged', () => {
    const doc = reduce(fixtureDocument(), {
      op: 'moveElement',
      pageId: P,
      elementId: ids.headline,
      x: 10,
      y: 10,
    });
    expect(codes(validateAgainstBrand(doc, fixtureSnapshot()))).toContain('blocking:safe_area');
  });
  it('possible overflow is a warning, never blocking (the render check is authoritative)', () => {
    const doc = reduce(fixtureDocument(), {
      op: 'setText',
      pageId: P,
      elementId: ids.body,
      text: 'x'.repeat(2000),
    });
    const f = validateAgainstBrand(doc, fixtureSnapshot()).find((x) => x.code === 'possible_overflow');
    expect(f?.severity).toBe('warning');
  });
});
