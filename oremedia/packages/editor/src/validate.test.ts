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

describe('static contrast uses what is actually under the text (spec 11.4)', () => {
  type Doc = ReturnType<typeof fixtureDocument>;
  type El = Doc['pages'][number]['elements'][number];
  /** Inserts `shape` directly beneath the body text (same parent, one step lower in paint order). */
  const withShapeUnderBody = (shape: (body: El) => El): Doc => {
    const doc = fixtureDocument();
    const visit = (els: El[]): boolean => {
      const i = els.findIndex((e) => e.id === ids.body);
      if (i >= 0) {
        els.splice(i, 0, shape(els[i]!));
        return true;
      }
      return els.some((e) => e.type === 'group' && visit(e.children));
    };
    visit(doc.pages[0]!.elements);
    return doc;
  };
  const rect = (body: El, over: Partial<El> & Record<string, unknown> = {}): El =>
    ({
      id: 'el_01J0SHAPE0000000000000000A',
      name: 'Panel',
      locked: false,
      visible: true,
      opacity: 1,
      protected: false,
      type: 'shape',
      shape: 'rect',
      fillToken: 'ink',
      strokeWidth: 0,
      cornerRadius: 0,
      transform: {
        x: body.transform.x - 10,
        y: body.transform.y - 10,
        width: body.transform.width + 20,
        height: body.transform.height + 20,
        rotation: 0,
      },
      ...over,
    }) as El;
  const contrast = (doc: Doc) =>
    validateAgainstBrand(doc, fixtureSnapshot()).filter(
      (f) => f.code === 'contrast' && f.elementId === ids.body,
    );

  it('dark text on a dark panel over a light page is blocking (the panel, not the page, is the backdrop)', () => {
    expect(contrast(withShapeUnderBody((b) => rect(b)))).toHaveLength(1);
  });
  it('light text on a dark panel covering it is clean although the page is light', () => {
    const doc = withShapeUnderBody((b) => rect(b));
    const lightText = reduce(doc, {
      op: 'setStyle',
      pageId: P,
      elementId: ids.body,
      patch: { colourToken: 'paper' },
    });
    expect(contrast(lightText)).toEqual([]);
  });
  it('text straddling a panel edge is checked against both sides (worst case)', () => {
    const doc = withShapeUnderBody((b) =>
      rect(b, { transform: { ...b.transform, width: b.transform.width / 2, rotation: 0 } }),
    );
    const lightText = reduce(doc, {
      op: 'setStyle',
      pageId: P,
      elementId: ids.body,
      patch: { colourToken: 'paper' },
    });
    // paper on the ink half passes, paper on the paper page does not.
    expect(contrast(lightText)).toHaveLength(1);
  });
  it('a translucent or rotated panel has no static colour; the page stays the backdrop', () => {
    for (const over of [{ opacity: 0.5 }, { transform: undefined }] as const) {
      const doc = withShapeUnderBody((b) =>
        over.transform === undefined && !('opacity' in over)
          ? rect(b, { transform: { ...rect(b).transform, rotation: 15 } })
          : rect(b, over),
      );
      expect(contrast(doc)).toEqual([]);
    }
  });
  it('a failure seen only through a translucent panel is a warning: the render check measures the blend', () => {
    const doc = withShapeUnderBody((b) => rect(b, { opacity: 0.85 }));
    const paperText = reduce(doc, {
      op: 'setStyle',
      pageId: P,
      elementId: ids.body,
      patch: { colourToken: 'paper' },
    });
    expect(contrast(paperText).map((f) => f.severity)).toEqual(['warning']);
  });
  it('shares of the same failing colour from separate panels add up to a block', () => {
    // two accent strips, each 6% of the text box (together 12%): ink text passes on the page (15:1) and fails on
    // accent (2.7:1)
    const doc = fixtureDocument();
    const visit = (els: El[]): boolean => {
      const i = els.findIndex((e) => e.id === ids.body);
      if (i < 0) return els.some((e) => e.type === 'group' && visit(e.children));
      const b = els[i];
      if (!b) return false;
      const strip = (n: number, x: number): El =>
        rect(b, {
          id: `el_01J0STR1P${n}00000000000000000`.slice(0, 29),
          fillToken: 'accent',
          transform: {
            x,
            y: b.transform.y,
            width: b.transform.width * 0.06,
            height: b.transform.height,
            rotation: 0,
          },
        });
      els.splice(i, 0, strip(1, b.transform.x), strip(2, b.transform.x + b.transform.width * 0.5));
      return true;
    };
    visit(doc.pages[0]?.elements ?? []);
    const inkText = reduce(doc, {
      op: 'setStyle',
      pageId: P,
      elementId: ids.body,
      patch: { colourToken: 'ink' },
    });
    expect(contrast(inkText).map((f) => f.severity)).toEqual(['blocking']);
  });
  it('a small translucent decoration over the text does not downgrade a failure against the page', () => {
    const doc = withShapeUnderBody((b) =>
      rect(b, {
        opacity: 0.4,
        transform: { x: b.transform.x, y: b.transform.y, width: 20, height: 20, rotation: 0 },
      }),
    );
    const mistText = reduce(doc, {
      op: 'setStyle',
      pageId: P,
      elementId: ids.body,
      patch: { colourToken: 'mist' },
    });
    expect(contrast(mistText).map((f) => f.severity)).toEqual(['blocking']);
  });
  it('an opaque unmasked image covering the text leaves contrast to the render check', () => {
    const doc = withShapeUnderBody((b) =>
      rect(b, {
        type: 'image',
        assetVersionId: 'av_1',
        fit: 'cover',
        fillToken: undefined,
        shape: undefined,
      }),
    );
    const paleText = reduce(doc, {
      op: 'setStyle',
      pageId: P,
      elementId: ids.body,
      patch: { colourToken: 'mist' },
    });
    expect(contrast(paleText)).toEqual([]);
  });
});
