import { describe, expect, it } from 'vitest';
import { hashCanonical } from '@oremedia/domain/hash';
import { CreativeDocumentV1 } from '@oremedia/contracts/creative';
import { applyBatch, changedElementIds, findElement, OperationError, reduce, reflow } from './reduce';
import { guardLogoInsertion, guardProtected } from './guard';
import { eid, fixtureDocument, ids } from './fixtures';
import { PolicyDeniedError } from '@oremedia/contracts/errors';

const reasonOf = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof PolicyDeniedError ? e.reason : `not_policy_error:${String(e)}`;
  }
};

const P = 'page_1';

describe('reducer (spec 11.3, 11.4)', () => {
  it('is pure: the input document is never mutated', () => {
    const doc = fixtureDocument();
    const before = hashCanonical(doc);
    reduce(doc, { op: 'setText', pageId: P, elementId: ids.headline, text: 'Changed' });
    expect(hashCanonical(doc)).toBe(before);
  });

  it('element ids are stable across every edit and the output stays schema-valid', () => {
    const doc = fixtureDocument();
    const next = applyBatch(doc, {
      operations: [
        { op: 'setText', pageId: P, elementId: ids.headline, text: 'New headline' },
        { op: 'moveElement', pageId: P, elementId: ids.image, x: 100, y: 300 },
        { op: 'resizeElement', pageId: P, elementId: ids.image, width: 800, height: 400 },
        { op: 'setStyle', pageId: P, elementId: ids.body, patch: { sizePx: 26, align: 'center' } },
        { op: 'reorderElement', pageId: P, elementId: ids.headline, toIndex: 4 },
        { op: 'setCrop', pageId: P, elementId: ids.image, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } },
        { op: 'setLock', pageId: P, elementId: ids.body, locked: true },
      ],
    });
    expect(CreativeDocumentV1.safeParse(next).success).toBe(true);
    const page = next.pages[0]!;
    expect(page.elements.map((e) => e.id).sort()).toEqual(doc.pages[0]!.elements.map((e) => e.id).sort());
    expect(page.elements[4]!.id).toBe(ids.headline);
    const body = findElement(page, ids.body);
    expect(body?.type === 'text' && body.style.sizePx).toBe(26);
    expect(body?.locked).toBe(true);
    const image = findElement(page, ids.image);
    expect(image?.transform).toMatchObject({ x: 100, y: 300, width: 800, height: 400 });
  });

  it('round-trips: undo is a new revision whose snapshot equals the earlier one', () => {
    const doc = fixtureDocument();
    const edited = reduce(doc, { op: 'setText', pageId: P, elementId: ids.headline, text: 'x' });
    const undone = reduce(edited, {
      op: 'setText',
      pageId: P,
      elementId: ids.headline,
      text: 'October offer',
    });
    expect(hashCanonical(undone)).toBe(hashCanonical(doc));
  });

  it('rejects structural errors with stable codes', () => {
    const doc = fixtureDocument();
    expect(() => reduce(doc, { op: 'setText', pageId: 'nope', elementId: ids.headline, text: 'x' })).toThrow(
      OperationError,
    );
    expect(() =>
      reduce(doc, { op: 'setText', pageId: P, elementId: 'el_01HZZZZZZZZZZZZZZZZZZZZZZZ', text: 'x' }),
    ).toThrowError(/element_not_found/);
    expect(() => reduce(doc, { op: 'setText', pageId: P, elementId: ids.image, text: 'x' })).toThrowError(
      /not_a_text_element/,
    );
    expect(() =>
      reduce(doc, { op: 'setStyle', pageId: P, elementId: ids.body, patch: { innerHTML: '<b>' } }),
    ).toThrowError(/style_key_not_allowed/);
    expect(() => reduce(doc, { op: 'moveElement', pageId: P, elementId: ids.bg, x: 1, y: 1 })).toThrowError(
      /element_locked/,
    );
    expect(() =>
      reduce(doc, { op: 'insertElement', pageId: P, element: doc.pages[0]!.elements[1]! }),
    ).toThrowError(/duplicate_element_id/);
    expect(() =>
      reduce(doc, { op: 'applyTemplate', pageId: P, templateVersionId: 'tv_x', slotBindings: {} }),
    ).toThrowError(/template_not_resolved/);
  });

  it('insert/remove keep z-order as array order', () => {
    const doc = fixtureDocument();
    const el = { ...doc.pages[0]!.elements[2]!, id: eid('01HNEW'), name: 'New' };
    const inserted = reduce(doc, { op: 'insertElement', pageId: P, element: el, index: 1 });
    expect(inserted.pages[0]!.elements[1]!.id).toBe(el.id);
    const removed = reduce(inserted, { op: 'removeElement', pageId: P, elementId: el.id });
    expect(hashCanonical(removed)).toBe(hashCanonical(doc));
  });

  it('createFormatVariant reflows via constraints, keeps aspect ratios and never scales pixels blindly', () => {
    const doc = fixtureDocument();
    const next = reduce(doc, { op: 'createFormatVariant', sourcePageId: P, formatKey: 'ig_story_9x16' });
    expect(next.pages.length).toBe(2);
    const story = next.pages[1]!;
    expect(story.width).toBe(1080);
    expect(story.height).toBe(1920);
    const logo = findElement(story, ids.logo)!;
    const srcLogo = findElement(doc.pages[0]!, ids.logo)!;
    expect(logo.transform.width / logo.transform.height).toBeCloseTo(
      srcLogo.transform.width / srcLogo.transform.height,
      6,
    );
    expect(logo.transform.y + logo.transform.height).toBeCloseTo(1920 - 60, 6); // anchored bottom, 60px margin
    const headline = findElement(story, ids.headline)!;
    expect(headline.transform.y).toBe(80); // anchored top
    const bg = findElement(story, ids.bg)!;
    expect(bg.transform).toMatchObject({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(CreativeDocumentV1.safeParse(next).success).toBe(true);
  });

  it('reflow scales text size with the minimum axis ratio', () => {
    const page = fixtureDocument().pages[0]!;
    const wide = reflow(page, 'li_1200x627', 1200, 627);
    const headline = findElement(wide, ids.headline)!;
    expect(headline.type === 'text' && headline.style.sizePx).toBeCloseTo(64 * (627 / 1080), 6);
  });

  it('changedElementIds lists the elements a batch touched', () => {
    expect(
      changedElementIds({
        operations: [
          { op: 'setText', pageId: P, elementId: ids.headline, text: 'x' },
          { op: 'moveElement', pageId: P, elementId: ids.image, x: 0, y: 0 },
        ],
      }).sort(),
    ).toEqual([ids.headline, ids.image].sort());
  });
});

describe('guards (spec 11.4: agents cannot touch protected elements)', () => {
  it('agents cannot move, resize, restyle, replace or remove a protected element; users can', () => {
    const doc = fixtureDocument();
    const ops = [
      { op: 'moveElement', pageId: P, elementId: ids.logo, x: 1, y: 1 },
      { op: 'resizeElement', pageId: P, elementId: ids.logo, width: 300, height: 90 },
      { op: 'replaceAsset', pageId: P, elementId: ids.logo, assetVersionId: 'av_other' },
      { op: 'removeElement', pageId: P, elementId: ids.logo },
      { op: 'setStyle', pageId: P, elementId: ids.logo, patch: { opacity: 0.5 } },
    ] as const;
    for (const op of ops) {
      expect(reasonOf(() => guardProtected(doc, op, 'agent'))).toBe('protected_element');
      expect(() => guardProtected(doc, op, 'user')).not.toThrow();
    }
    expect(() =>
      guardProtected(doc, { op: 'setText', pageId: P, elementId: ids.headline, text: 'x' }, 'agent'),
    ).not.toThrow();
  });
  it('agents cannot insert logo elements', () => {
    const logo = fixtureDocument().pages[0]!.elements[4]!;
    expect(() =>
      guardLogoInsertion(
        { op: 'insertElement', pageId: P, element: { ...logo, id: 'el_01HZZZZZZZZZZZZZZZZZZZZZL2' } },
        'agent',
      ),
    ).toThrowError(/agent_logo_insert/);
    expect(() =>
      guardLogoInsertion(
        { op: 'insertElement', pageId: P, element: { ...logo, id: 'el_01HZZZZZZZZZZZZZZZZZZZZZL2' } },
        'user',
      ),
    ).not.toThrow();
  });
});
