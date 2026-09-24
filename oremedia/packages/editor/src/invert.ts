import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  Operation,
  OperationBatch,
} from '@oremedia/contracts/creative';
import { reduce, type ReduceContext } from './reduce';

/**
 * Spec 11.4: undo is a NEW revision whose snapshot equals an earlier one; history is never rewritten. The inverse
 * of a batch is therefore itself an operation batch, computed against the document the batch was applied to.
 *
 * Page-level operations have no inverse in the operation contract (there is no removePage), so a batch containing
 * addPage or createFormatVariant is reported as not invertible rather than guessed at.
 */
export type InvertResult =
  { ok: true; operations: Operation[] } | { ok: false; reason: string; op: Operation['op'] };

const pageOf = (doc: CreativeDocumentV1, pageId: string): CreativePage | undefined =>
  doc.pages.find((p) => p.id === pageId);

/** Top-level index of an element on a page; nested elements (inside groups) return -1. */
const topLevelIndex = (page: CreativePage, elementId: string): number =>
  page.elements.findIndex((e) => e.id === elementId);

const findNested = (elements: Element[], elementId: string): Element | null => {
  for (const el of elements) {
    if (el.id === elementId) return el;
    if (el.type === 'group') {
      const found = findNested(el.children, elementId);
      if (found) return found;
    }
  }
  return null;
};

const notInvertible = (op: Operation['op'], reason: string): InvertResult => ({ ok: false, reason, op });

/** The old value of every key a setStyle patch touches; text style keys live under `style`, the rest on the element. */
function styleBefore(el: Element, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const bag: Record<string, unknown> =
    el.type === 'text' ? { ...(el.style as Record<string, unknown>), opacity: el.opacity } : { ...el };
  for (const k of Object.keys(patch)) out[k] = bag[k];
  return out;
}

/** Restores one top-level element in place: remove whatever is there now, insert the old element at its old index. */
const restoreSequence = (pageId: string, element: Element, index: number): Operation[] => [
  { op: 'removeElement', pageId, elementId: element.id },
  { op: 'insertElement', pageId, element: structuredClone(element), index },
];

function invertOne(doc: CreativeDocumentV1, op: Operation, ctx: ReduceContext): Operation[] | InvertResult {
  switch (op.op) {
    case 'addPage':
    case 'createFormatVariant':
      return notInvertible(op.op, `no_inverse:${op.op}`);
    case 'applyTemplate': {
      const page = pageOf(doc, op.pageId);
      if (!page) return notInvertible(op.op, 'page_not_found');
      const after = reduce(doc, op, ctx);
      const afterPage = pageOf(after, op.pageId);
      if (!afterPage) return notInvertible(op.op, 'page_not_found');
      // Elements are restored; the page's layoutConstraints and the document's templateVersionId are template
      // metadata with no operation of their own and stay as the template left them.
      const ops: Operation[] = afterPage.elements.map((e) => ({
        op: 'removeElement',
        pageId: op.pageId,
        elementId: e.id,
      }));
      page.elements.forEach((e, index) =>
        ops.push({ op: 'insertElement', pageId: op.pageId, element: structuredClone(e), index }),
      );
      return ops;
    }
    case 'insertElement':
      return [{ op: 'removeElement', pageId: op.pageId, elementId: op.element.id }];
    default: {
      const page = pageOf(doc, op.pageId);
      if (!page) return notInvertible(op.op, 'page_not_found');
      const el = findNested(page.elements, op.elementId);
      if (!el) return notInvertible(op.op, 'element_not_found');
      const index = topLevelIndex(page, op.elementId);
      switch (op.op) {
        case 'removeElement':
          if (index < 0) return notInvertible(op.op, 'nested_element');
          return [{ op: 'insertElement', pageId: op.pageId, element: structuredClone(el), index }];
        case 'setText':
          if (el.type !== 'text') return notInvertible(op.op, 'not_a_text_element');
          return [
            { op: 'setText', pageId: op.pageId, elementId: el.id, text: el.text, factRefs: [...el.factRefs] },
          ];
        case 'setStyle':
          return [{ op: 'setStyle', pageId: op.pageId, elementId: el.id, patch: styleBefore(el, op.patch) }];
        case 'replaceAsset': {
          const old =
            el.type === 'image' || el.type === 'logo' || el.type === 'background'
              ? el.assetVersionId
              : undefined;
          if (old === undefined) {
            if (index < 0) return notInvertible(op.op, 'nested_element');
            return restoreSequence(op.pageId, el, index);
          }
          return [{ op: 'replaceAsset', pageId: op.pageId, elementId: el.id, assetVersionId: old }];
        }
        case 'moveElement':
          return [
            { op: 'moveElement', pageId: op.pageId, elementId: el.id, x: el.transform.x, y: el.transform.y },
          ];
        case 'resizeElement':
          return [
            {
              op: 'resizeElement',
              pageId: op.pageId,
              elementId: el.id,
              width: el.transform.width,
              height: el.transform.height,
            },
          ];
        case 'reorderElement': {
          if (index < 0) return notInvertible(op.op, 'nested_element');
          return [{ op: 'reorderElement', pageId: op.pageId, elementId: el.id, toIndex: index }];
        }
        case 'setCrop': {
          if (el.type !== 'image') return notInvertible(op.op, 'not_an_image');
          if (!el.crop) {
            if (index < 0) return notInvertible(op.op, 'nested_element');
            return restoreSequence(op.pageId, el, index);
          }
          return [{ op: 'setCrop', pageId: op.pageId, elementId: el.id, crop: { ...el.crop } }];
        }
        case 'setLock':
          return [{ op: 'setLock', pageId: op.pageId, elementId: el.id, locked: el.locked }];
      }
    }
  }
}

/**
 * The operations that restore `before` from `applyBatch(before, batch)`. Each operation is inverted against the
 * document state it was applied to, and the inverses are returned in reverse order so that
 * `applyBatch(applyBatch(before, batch), inverse)` deep-equals `before` (canonical JSON) for every invertible op.
 * `ctx.templates` is needed only when the batch contains applyTemplate (the reducer never fetches).
 */
export function invertBatch(
  before: CreativeDocumentV1,
  batch: Pick<OperationBatch, 'operations'>,
  ctx: ReduceContext = {},
): InvertResult {
  const inverses: Operation[][] = [];
  let current = before;
  for (const op of batch.operations) {
    const inv = invertOne(current, op, ctx);
    if (!Array.isArray(inv)) return inv;
    inverses.push(inv);
    current = reduce(current, op, ctx);
  }
  return { ok: true, operations: inverses.reverse().flat() };
}
