import type {
  CreativeDocumentV1,
  CreativePage,
  Element,
  Finding,
  Operation,
  OperationBatch,
  TemplateSlotConstraints,
} from '@oremedia/contracts/creative';
import { CreativeDocumentV1 as DocumentSchema, ElementSchema } from '@oremedia/contracts/creative';
import { formatFor } from './formats';

/** A rejected operation: the reducer is pure and reports structural problems as errors with stable codes. */
export class OperationError extends Error {
  readonly code: string;
  readonly op: Operation['op'];
  constructor(code: string, op: Operation['op'], message?: string) {
    super(message ?? `${op}: ${code}`);
    this.name = 'OperationError';
    this.code = code;
    this.op = op;
  }
}

export interface TemplateDocument {
  /** The template's page used as the source of elements; slot key → element id inside that page. */
  page: CreativePage;
  slots: Array<{
    key: string;
    elementId: string;
    kind: string;
    required: boolean;
    /** Absent means true: versions stored before slot semantics bind like before. */
    replaceable?: boolean;
    constraints?: TemplateSlotConstraints;
  }>;
}

/** A blocking finding about one slot binding of an applyTemplate operation (spec 6.3 / 11.3 slot semantics). */
export type SlotFinding = Finding & { slotKey: string };

/**
 * applyTemplate rejected because slot bindings break the template's slot rules. `code` keeps the stable
 * `<finding code>:<slot key>` shape of the first violation (e.g. `slot_unbound:headline`); `findings` lists them all.
 */
export class SlotConstraintError extends OperationError {
  readonly findings: SlotFinding[];
  constructor(findings: SlotFinding[]) {
    const first = findings[0];
    super(first ? `${first.code}:${first.slotKey}` : 'slot_constraint', 'applyTemplate');
    this.name = 'SlotConstraintError';
    this.findings = findings;
  }
}

/** Element type a bound element must have per enforced slot kind; other kinds (legacy versions) are not typed. */
const SLOT_ELEMENT_TYPE: Readonly<Record<string, Element['type']>> = {
  text: 'text',
  image: 'image',
  logo: 'logo',
  background: 'background',
};

/**
 * Spec 6.3 / 11.3: every binding names a slot of the template, is allowed to replace it, points at an element of
 * the target page of the slot's kind and satisfies the slot's constraints (text length, semantic roles); every
 * required slot is bound and no element fills two slots. Pure: the findings are returned, nothing is thrown.
 */
export function validateSlotBindings(
  template: TemplateDocument,
  page: CreativePage,
  slotBindings: Readonly<Record<string, string>>,
): SlotFinding[] {
  const findings: SlotFinding[] = [];
  const add = (slotKey: string, code: string, message: string, elementId?: string) =>
    findings.push({
      slotKey,
      code,
      severity: 'blocking',
      message,
      pageId: page.id,
      ...(elementId ? { elementId } : {}),
    });
  const slots = new Map(template.slots.map((s) => [s.key, s]));
  for (const key of Object.keys(slotBindings))
    if (!slots.has(key)) add(key, 'slot_unknown', `The template has no slot "${key}"`);
  const boundBy = new Map<string, string>();
  for (const slot of template.slots) {
    const boundId = slotBindings[slot.key];
    if (!boundId) {
      if (slot.required) add(slot.key, 'slot_unbound', `Slot "${slot.key}" is required`);
      continue;
    }
    if (slot.replaceable === false) {
      add(slot.key, 'slot_not_replaceable', `Slot "${slot.key}" is fixed by the template`, boundId);
      continue;
    }
    const previous = boundBy.get(boundId);
    if (previous !== undefined)
      add(slot.key, 'slot_binding_duplicate', `The element already fills slot "${previous}"`, boundId);
    boundBy.set(boundId, slot.key);
    const element = locate(page.elements, boundId)?.element;
    if (!element) {
      add(slot.key, 'slot_binding_not_found', `The bound element is not on page ${page.id}`, boundId);
      continue;
    }
    const expectedType = SLOT_ELEMENT_TYPE[slot.kind];
    if (expectedType !== undefined && element.type !== expectedType) {
      add(
        slot.key,
        'slot_kind_mismatch',
        `Slot "${slot.key}" takes a ${expectedType} element, not ${element.type}`,
        boundId,
      );
      continue;
    }
    const c = slot.constraints ?? {};
    if (c.semanticRoles && !(element.semanticRole && c.semanticRoles.includes(element.semanticRole)))
      add(
        slot.key,
        'slot_role_not_allowed',
        `Slot "${slot.key}" takes ${c.semanticRoles.join(', ')} elements only`,
        boundId,
      );
    if (element.type === 'text') {
      const length = [...element.text].length;
      if (c.maxLength !== undefined && length > c.maxLength)
        add(
          slot.key,
          'slot_text_too_long',
          `Slot "${slot.key}" takes at most ${c.maxLength} characters (${length} given)`,
          boundId,
        );
      if (c.minLength !== undefined && length < c.minLength)
        add(
          slot.key,
          'slot_text_too_short',
          `Slot "${slot.key}" takes at least ${c.minLength} characters (${length} given)`,
          boundId,
        );
    }
  }
  return findings;
}

export interface ReduceContext {
  /** applyTemplate needs the template version document; the caller resolves it (the reducer never fetches). */
  templates?: Readonly<Record<string, TemplateDocument>>;
}

const pageOf = (doc: CreativeDocumentV1, pageId: string, op: Operation['op']): CreativePage => {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) throw new OperationError('page_not_found', op);
  return page;
};

/** Depth-first search through groups. Returns the containing array and index so edits stay local. */
function locate(
  elements: Element[],
  elementId: string,
): { parent: Element[]; index: number; element: Element } | null {
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i] as Element;
    if (el.id === elementId) return { parent: elements, index: i, element: el };
    if (el.type === 'group') {
      const found = locate(el.children, elementId);
      if (found) return found;
    }
  }
  return null;
}

export function findElement(page: CreativePage, elementId: string): Element | null {
  return locate(page.elements, elementId)?.element ?? null;
}

const requireElement = (page: CreativePage, elementId: string, op: Operation['op']) => {
  const found = locate(page.elements, elementId);
  if (!found) throw new OperationError('element_not_found', op);
  return found;
};

const STYLE_KEYS_BY_TYPE: Record<string, ReadonlySet<string>> = {
  text: new Set([
    'typeRole',
    'fontAssetVersionId',
    'weight',
    'sizePx',
    'lineHeight',
    'tracking',
    'colourToken',
    'colourValue',
    'align',
    'overflow',
  ]),
  shape: new Set(['fillToken', 'strokeToken', 'strokeWidth', 'cornerRadius', 'opacity']),
  background: new Set(['fillToken', 'opacity']),
  image: new Set(['fit', 'mask', 'focalPoint', 'opacity']),
  logo: new Set(['opacity']),
  group: new Set(['opacity']),
};

function applyStyle(el: Element, patch: Record<string, unknown>): Element {
  const allowed = STYLE_KEYS_BY_TYPE[el.type] ?? new Set<string>();
  for (const k of Object.keys(patch))
    if (!allowed.has(k)) throw new OperationError(`style_key_not_allowed:${k}`, 'setStyle');
  if (el.type === 'text') {
    const { opacity: _o, ...stylePatch } = patch;
    return { ...el, style: { ...el.style, ...(stylePatch as Partial<typeof el.style>) } };
  }
  return { ...el, ...(patch as Partial<Element>) } as Element;
}

/**
 * Spec 11.4: `next = reduce(next, op)`, pure. Element ids are stable across every edit; z-order is array order;
 * a document is never partially mutated (each call returns a new document or throws).
 */
export function reduce(doc: CreativeDocumentV1, op: Operation, ctx: ReduceContext = {}): CreativeDocumentV1 {
  const next: CreativeDocumentV1 = structuredClone(doc);
  switch (op.op) {
    case 'insertElement': {
      const page = pageOf(next, op.pageId, op.op);
      if (locate(page.elements, op.element.id)) throw new OperationError('duplicate_element_id', op.op);
      if (page.elements.length >= 300) throw new OperationError('too_many_elements', op.op);
      const index =
        op.index === undefined ? page.elements.length : Math.max(0, Math.min(op.index, page.elements.length));
      page.elements.splice(index, 0, ElementSchema.parse(op.element));
      return next;
    }
    case 'removeElement': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index } = requireElement(page, op.elementId, op.op);
      parent.splice(index, 1);
      return next;
    }
    case 'setText': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      if (element.type !== 'text') throw new OperationError('not_a_text_element', op.op);
      parent[index] = { ...element, text: op.text, factRefs: op.factRefs ?? element.factRefs };
      return next;
    }
    case 'setStyle': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      parent[index] = ElementSchema.parse(applyStyle(element, op.patch));
      return next;
    }
    case 'replaceAsset': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      if (element.type !== 'image' && element.type !== 'logo' && element.type !== 'background')
        throw new OperationError('element_has_no_asset', op.op);
      parent[index] = { ...element, assetVersionId: op.assetVersionId };
      return next;
    }
    case 'moveElement': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      if (element.locked) throw new OperationError('element_locked', op.op);
      parent[index] = { ...element, transform: { ...element.transform, x: op.x, y: op.y } };
      return next;
    }
    case 'resizeElement': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      if (element.locked) throw new OperationError('element_locked', op.op);
      parent[index] = { ...element, transform: { ...element.transform, width: op.width, height: op.height } };
      return next;
    }
    case 'reorderElement': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index } = requireElement(page, op.elementId, op.op);
      const [el] = parent.splice(index, 1);
      const to = Math.max(0, Math.min(op.toIndex, parent.length));
      parent.splice(to, 0, el as Element);
      return next;
    }
    case 'setCrop': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      if (element.type !== 'image') throw new OperationError('not_an_image', op.op);
      if (op.crop.width <= 0 || op.crop.height <= 0) throw new OperationError('invalid_crop', op.op);
      parent[index] = { ...element, crop: op.crop };
      return next;
    }
    case 'applyTemplate': {
      const page = pageOf(next, op.pageId, op.op);
      const template = ctx.templates?.[op.templateVersionId];
      if (!template) throw new OperationError('template_not_resolved', op.op);
      const slotFindings = validateSlotBindings(template, page, op.slotBindings);
      if (slotFindings.length) throw new SlotConstraintError(slotFindings);
      // Template elements come in with their template ids; bound slots take the existing element's content.
      const incoming = structuredClone(template.page.elements);
      for (const slot of template.slots) {
        const boundId = op.slotBindings[slot.key];
        if (!boundId) continue;
        const existing = locate(page.elements, boundId)?.element;
        const target = locate(incoming, slot.elementId);
        if (!existing || !target) continue;
        const merged = { ...target.element, id: existing.id } as Element;
        if (existing.type === 'text' && merged.type === 'text')
          target.parent[target.index] = { ...merged, text: existing.text, factRefs: existing.factRefs };
        else if (
          (existing.type === 'image' || existing.type === 'logo') &&
          (merged.type === 'image' || merged.type === 'logo')
        )
          target.parent[target.index] = { ...merged, assetVersionId: existing.assetVersionId } as Element;
        else target.parent[target.index] = merged;
      }
      next.templateVersionId = op.templateVersionId;
      const target = pageOf(next, op.pageId, op.op);
      target.elements = incoming;
      target.layoutConstraints = structuredClone(template.page.layoutConstraints);
      return next;
    }
    case 'addPage': {
      if (next.pages.length >= 20) throw new OperationError('too_many_pages', op.op);
      if (next.pages.some((p) => p.id === op.page.id)) throw new OperationError('duplicate_page_id', op.op);
      const index =
        op.index === undefined ? next.pages.length : Math.max(0, Math.min(op.index, next.pages.length));
      next.pages.splice(index, 0, structuredClone(op.page));
      return next;
    }
    case 'createFormatVariant': {
      const source = pageOf(next, op.sourcePageId, op.op);
      const format = formatFor(op.formatKey);
      if (!format) throw new OperationError('unknown_format', op.op);
      if (next.pages.length >= 20) throw new OperationError('too_many_pages', op.op);
      next.pages.push(reflow(source, format.key, format.width, format.height));
      return next;
    }
    case 'setLock': {
      const page = pageOf(next, op.pageId, op.op);
      const { parent, index, element } = requireElement(page, op.elementId, op.op);
      parent[index] = { ...element, locked: op.locked };
      return next;
    }
  }
}

/**
 * Spec 11.3 createFormatVariant: reflows via layout constraints; never scales pixels blindly. Anchored elements keep
 * their margins to the anchored edge; other elements scale by the smaller axis ratio (aspect preserved) and are
 * re-centred proportionally. Text sizes scale with the same factor so line breaks stay comparable.
 */
export function reflow(source: CreativePage, formatKey: string, width: number, height: number): CreativePage {
  const rx = width / source.width;
  const ry = height / source.height;
  const s = Math.min(rx, ry);
  const constraints = new Map(source.layoutConstraints.map((c) => [c.elementId, c]));
  const place = (el: Element): Element => {
    const t = el.transform;
    const w = t.width * s;
    const h = t.height * s;
    let x = (t.x + t.width / 2) * rx - w / 2;
    let y = (t.y + t.height / 2) * ry - h / 2;
    const c = constraints.get(el.id);
    if (c) {
      if (c.anchor === 'top') y = c.marginPx;
      if (c.anchor === 'bottom') y = height - c.marginPx - h;
      if (c.anchor === 'left') x = c.marginPx;
      if (c.anchor === 'right') x = width - c.marginPx - w;
      if (c.anchor === 'center') {
        x = (width - w) / 2;
        y = (height - h) / 2;
      }
    }
    if (el.type === 'background') return { ...el, transform: { x: 0, y: 0, width, height, rotation: 0 } };
    const base = { ...el, transform: { ...t, x, y, width: w, height: h } } as Element;
    if (base.type === 'text')
      return {
        ...base,
        style: { ...base.style, sizePx: base.style.sizePx * s, lineHeight: base.style.lineHeight },
      };
    if (base.type === 'group') return { ...base, children: base.children.map(place) };
    return base;
  };
  return {
    id: `${source.id}_${formatKey}`,
    name: `${source.name} (${formatKey})`,
    formatKey,
    width,
    height,
    elements: source.elements.map(place),
    layoutConstraints: structuredClone(source.layoutConstraints),
  };
}

export function applyBatch(
  doc: CreativeDocumentV1,
  batch: Pick<OperationBatch, 'operations'>,
  ctx: ReduceContext = {},
): CreativeDocumentV1 {
  let next = doc;
  for (const op of batch.operations) next = reduce(next, op, ctx);
  return DocumentSchema.parse(next);
}

/** Element ids touched by a batch (spec 11.4: anchored comments do not silently drift). */
export function changedElementIds(batch: Pick<OperationBatch, 'operations'>): string[] {
  const ids = new Set<string>();
  for (const op of batch.operations) {
    if ('elementId' in op) ids.add(op.elementId);
    if (op.op === 'insertElement') ids.add(op.element.id);
    if (op.op === 'applyTemplate') for (const id of Object.values(op.slotBindings)) ids.add(id);
  }
  return [...ids];
}

/** Ids of every element in the document (for comment outdating on page-level operations). */
export function allElementIds(doc: CreativeDocumentV1): string[] {
  const out: string[] = [];
  const walk = (els: Element[]) => {
    for (const el of els) {
      out.push(el.id);
      if (el.type === 'group') walk(el.children);
    }
  };
  for (const p of doc.pages) walk(p.elements);
  return out;
}
