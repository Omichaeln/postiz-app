import { describe, expect, it } from 'vitest';
import { hashCanonical } from '@oremedia/domain/hash';
import type { Element, Operation } from '@oremedia/contracts/creative';
import { applyBatch, findElement, type TemplateDocument } from './reduce';
import { invertBatch } from './invert';
import { eid, fixtureDocument, ids } from './fixtures';

const P = 'page_1';

/** applyBatch(applyBatch(doc, ops), invert) ≡ doc, compared as canonical JSON (spec 11.4 undo). */
const roundTrips = (ops: Operation[], ctx = {}) => {
  const doc = fixtureDocument();
  const edited = applyBatch(doc, { operations: ops }, ctx);
  expect(hashCanonical(edited)).not.toBe(hashCanonical(doc));
  const inverse = invertBatch(doc, { operations: ops }, ctx);
  if (!inverse.ok) throw new Error(`expected invertible: ${inverse.reason}`);
  const restored = applyBatch(edited, { operations: inverse.operations }, ctx);
  expect(hashCanonical(restored)).toBe(hashCanonical(doc));
  return inverse.operations;
};

describe('invertBatch (spec 11.4: undo is a new revision whose snapshot equals an earlier one)', () => {
  const single: Array<[string, Operation]> = [
    ['setText', { op: 'setText', pageId: P, elementId: ids.headline, text: 'Changed', factRefs: ['fact_1'] }],
    [
      'setStyle (text)',
      { op: 'setStyle', pageId: P, elementId: ids.body, patch: { sizePx: 30, align: 'center', tracking: 2 } },
    ],
    [
      'setStyle (image)',
      { op: 'setStyle', pageId: P, elementId: ids.image, patch: { fit: 'contain', opacity: 0.5 } },
    ],
    ['replaceAsset', { op: 'replaceAsset', pageId: P, elementId: ids.image, assetVersionId: 'av_other' }],
    ['moveElement', { op: 'moveElement', pageId: P, elementId: ids.image, x: 10, y: 20 }],
    ['resizeElement', { op: 'resizeElement', pageId: P, elementId: ids.image, width: 500, height: 250 }],
    ['reorderElement', { op: 'reorderElement', pageId: P, elementId: ids.headline, toIndex: 0 }],
    ['reorderElement (clamped)', { op: 'reorderElement', pageId: P, elementId: ids.image, toIndex: 99 }],
    [
      'setCrop (no crop before)',
      { op: 'setCrop', pageId: P, elementId: ids.image, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    ],
    ['setLock', { op: 'setLock', pageId: P, elementId: ids.body, locked: true }],
    ['removeElement', { op: 'removeElement', pageId: P, elementId: ids.body }],
    [
      'insertElement',
      {
        op: 'insertElement',
        pageId: P,
        element: { ...(fixtureDocument().pages[0]!.elements[3] as Element), id: eid('01HNEW'), name: 'New' },
        index: 1,
      },
    ],
  ];
  for (const [name, op] of single)
    it(`round-trips ${name}`, () => {
      roundTrips([op]);
    });

  it('a setStyle inverse restores keys that were absent before (colourToken → undefined)', () => {
    const inverse = roundTrips([
      {
        op: 'setStyle',
        pageId: P,
        elementId: ids.body,
        patch: { colourToken: undefined, colourValue: '#000000' },
      },
    ]);
    expect(inverse).toEqual([
      {
        op: 'setStyle',
        pageId: P,
        elementId: ids.body,
        patch: { colourToken: 'ink', colourValue: undefined },
      },
    ]);
  });

  it('setCrop with an existing crop inverts to the old crop', () => {
    const doc = applyBatch(fixtureDocument(), {
      operations: [
        { op: 'setCrop', pageId: P, elementId: ids.image, crop: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    });
    const op: Operation = {
      op: 'setCrop',
      pageId: P,
      elementId: ids.image,
      crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    };
    const inverse = invertBatch(doc, { operations: [op] });
    expect(inverse).toEqual({
      ok: true,
      operations: [
        { op: 'setCrop', pageId: P, elementId: ids.image, crop: { x: 0, y: 0, width: 1, height: 1 } },
      ],
    });
    expect(
      hashCanonical(
        applyBatch(applyBatch(doc, { operations: [op] }), {
          operations: inverse.ok ? inverse.operations : [],
        }),
      ),
    ).toBe(hashCanonical(doc));
  });

  it('a multi-operation batch inverts in reverse order', () => {
    const inverse = roundTrips([
      { op: 'setText', pageId: P, elementId: ids.headline, text: 'A' },
      { op: 'moveElement', pageId: P, elementId: ids.headline, x: 5, y: 5 },
      { op: 'removeElement', pageId: P, elementId: ids.body },
      { op: 'setText', pageId: P, elementId: ids.headline, text: 'B' },
    ]);
    expect(inverse.map((o) => o.op)).toEqual(['setText', 'insertElement', 'moveElement', 'setText']);
    expect(inverse[0]).toMatchObject({ text: 'A' });
    expect(inverse[3]).toMatchObject({ text: 'October offer' });
  });

  it('applyTemplate inverts to the remove+insert sequence that restores the page elements', () => {
    const doc = fixtureDocument();
    const templatePage = structuredClone(doc.pages[0]!);
    templatePage.elements = [
      { ...(templatePage.elements[0] as Element), id: eid('01HTBG') },
      { ...(templatePage.elements[2] as Element), id: eid('01HTHEAD'), name: 'Template headline' },
    ];
    const templates: Record<string, TemplateDocument> = {
      tv_1: {
        page: templatePage,
        slots: [{ key: 'headline', elementId: eid('01HTHEAD'), kind: 'text', required: true }],
      },
    };
    const op: Operation = {
      op: 'applyTemplate',
      pageId: P,
      templateVersionId: 'tv_1',
      slotBindings: { headline: ids.headline },
    };
    const edited = applyBatch(doc, { operations: [op] }, { templates });
    expect(edited.pages[0]!.elements.length).toBe(2);
    const inverse = invertBatch(doc, { operations: [op] }, { templates });
    if (!inverse.ok) throw new Error(inverse.reason);
    const restored = applyBatch(edited, { operations: inverse.operations }, { templates });
    expect(hashCanonical(restored.pages[0]!.elements)).toBe(hashCanonical(doc.pages[0]!.elements));
    expect(findElement(restored.pages[0]!, ids.headline)?.name).toBe('Headline');
    // Template metadata has no operation of its own and stays as the template left it (documented limitation).
    expect(restored.templateVersionId).toBe('tv_1');
  });

  it('page-level operations without an inverse are reported, never guessed', () => {
    const doc = fixtureDocument();
    const variant = invertBatch(doc, {
      operations: [{ op: 'createFormatVariant', sourcePageId: P, formatKey: 'ig_story_9x16' }],
    });
    expect(variant).toEqual({
      ok: false,
      reason: 'no_inverse:createFormatVariant',
      op: 'createFormatVariant',
    });
    const added = invertBatch(doc, {
      operations: [
        { op: 'setText', pageId: P, elementId: ids.headline, text: 'x' },
        { op: 'addPage', page: { ...doc.pages[0]!, id: 'page_2' } },
      ],
    });
    expect(added).toMatchObject({ ok: false, op: 'addPage' });
  });

  it('reports structural problems instead of producing a wrong inverse', () => {
    const doc = fixtureDocument();
    expect(
      invertBatch(doc, {
        operations: [{ op: 'setText', pageId: 'nope', elementId: ids.headline, text: 'x' }],
      }),
    ).toEqual({
      ok: false,
      reason: 'page_not_found',
      op: 'setText',
    });
    expect(
      invertBatch(doc, { operations: [{ op: 'setText', pageId: P, elementId: eid('01HNPE'), text: 'x' }] }),
    ).toEqual({ ok: false, reason: 'element_not_found', op: 'setText' });
    expect(
      invertBatch(doc, { operations: [{ op: 'setText', pageId: P, elementId: ids.image, text: 'x' }] }),
    ).toEqual({
      ok: false,
      reason: 'not_a_text_element',
      op: 'setText',
    });
  });

  it('never mutates the input document', () => {
    const doc = fixtureDocument();
    const before = hashCanonical(doc);
    invertBatch(doc, { operations: [{ op: 'removeElement', pageId: P, elementId: ids.body }] });
    expect(hashCanonical(doc)).toBe(before);
  });
});
