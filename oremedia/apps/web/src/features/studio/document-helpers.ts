import type { CreativeDocumentV1, CreativePage, Element } from '@oremedia/contracts/creative';

export interface LayerRow {
  element: Element;
  depth: number;
  /** Index among its siblings (z-order = array order, spec 11.2). */
  index: number;
  siblings: number;
  topLevel: boolean;
}

/** Layers panel order: front-most first (last array element on top). */
export function layerRows(page: CreativePage): LayerRow[] {
  const out: LayerRow[] = [];
  const walk = (elements: Element[], depth: number, topLevel: boolean) => {
    for (let i = elements.length - 1; i >= 0; i--) {
      const element = elements[i] as Element;
      out.push({ element, depth, index: i, siblings: elements.length, topLevel });
      if (element.type === 'group') walk(element.children, depth + 1, false);
    }
  };
  walk(page.elements, 0, true);
  return out;
}

export function elementName(doc: CreativeDocumentV1, elementId: string): string {
  for (const page of doc.pages)
    for (const row of layerRows(page)) if (row.element.id === elementId) return row.element.name;
  return elementId;
}

export function assetVersionIdsOf(doc: CreativeDocumentV1): string[] {
  const ids = new Set<string>();
  const walk = (elements: Element[]) => {
    for (const el of elements) {
      if (el.type === 'image' || el.type === 'logo') ids.add(el.assetVersionId);
      else if (el.type === 'background' && el.assetVersionId) ids.add(el.assetVersionId);
      else if (el.type === 'group') walk(el.children);
    }
  };
  for (const p of doc.pages) walk(p.elements);
  return [...ids].sort();
}

export function fontRefsOf(doc: CreativeDocumentV1): string[] {
  const refs = new Set<string>();
  const walk = (elements: Element[]) => {
    for (const el of elements) {
      if (el.type === 'text') refs.add(el.style.fontAssetVersionId);
      else if (el.type === 'group') walk(el.children);
    }
  };
  for (const p of doc.pages) walk(p.elements);
  return [...refs].sort();
}

export const elementTypeLabel: Record<Element['type'], string> = {
  text: 'Text',
  image: 'Image',
  logo: 'Logo',
  shape: 'Shape',
  background: 'Background',
  group: 'Group',
};
