import type { CreativeDocumentV1, Element } from '@oremedia/contracts/creative';

/** Key-sorted JSON (undefined omitted): enough to tell whether an element changed; hashes stay server-side. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
  return `{${entries.join(',')}}`;
}

export type DiffKind = 'added' | 'changed' | 'removed';

export interface ElementDiff {
  kind: DiffKind;
  pageId: string;
  element: Element;
}

const flat = (elements: Element[], out: Element[] = []): Element[] => {
  for (const el of elements) {
    out.push(el);
    if (el.type === 'group') flat(el.children, out);
  }
  return out;
};

/** Spec 21.4: an agent proposal renders as an overlay diff (added, changed, removed elements). */
export function diffDocuments(before: CreativeDocumentV1, after: CreativeDocumentV1): ElementDiff[] {
  const out: ElementDiff[] = [];
  const afterPages = new Map(after.pages.map((p) => [p.id, p]));
  for (const page of before.pages) {
    const next = afterPages.get(page.id);
    const beforeEls = new Map(flat(page.elements).map((e) => [e.id, e]));
    const afterEls = new Map(flat(next?.elements ?? []).map((e) => [e.id, e]));
    for (const [id, el] of beforeEls) {
      const other = afterEls.get(id);
      if (!other) out.push({ kind: 'removed', pageId: page.id, element: el });
      else if (stableJson(el) !== stableJson(other))
        out.push({ kind: 'changed', pageId: page.id, element: other });
    }
    for (const [id, el] of afterEls)
      if (!beforeEls.has(id)) out.push({ kind: 'added', pageId: page.id, element: el });
  }
  for (const page of after.pages)
    if (!before.pages.some((p) => p.id === page.id))
      for (const el of flat(page.elements)) out.push({ kind: 'added', pageId: page.id, element: el });
  return out;
}
