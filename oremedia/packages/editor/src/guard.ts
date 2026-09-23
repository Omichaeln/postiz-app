import type { CreativeDocumentV1, Operation } from '@oremedia/contracts/creative';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { findElement } from './reduce';

/** Spec 11.2/11.4: protected elements (e.g. logos) cannot be moved, resized, recoloured, replaced or removed by agents. */
const MUTATING_ON_ELEMENT = new Set<Operation['op']>([
  'removeElement',
  'setStyle',
  'replaceAsset',
  'moveElement',
  'resizeElement',
  'setCrop',
  'reorderElement',
  'setLock',
  'setText',
]);

export function guardProtected(doc: CreativeDocumentV1, op: Operation, origin: 'user' | 'agent'): void {
  if (origin !== 'agent') return;
  if (!('elementId' in op) || !MUTATING_ON_ELEMENT.has(op.op)) return;
  const page = doc.pages.find((p) => p.id === op.pageId);
  const el = page ? findElement(page, op.elementId) : null;
  if (!el) return; // the reducer reports element_not_found
  if (el.protected || el.type === 'logo')
    throw new PolicyDeniedError('protected_element', `Agents cannot change protected element ${el.id}`);
}

/** Logos are always approved original asset files (spec 2.2): agents may not insert logo elements or generated logos. */
export function guardLogoInsertion(op: Operation, origin: 'user' | 'agent'): void {
  if (origin !== 'agent') return;
  if (op.op === 'insertElement' && op.element.type === 'logo')
    throw new PolicyDeniedError(
      'agent_logo_insert',
      'Agents cannot add logo elements; logos are placed from approved assets by a person',
    );
}
