import type { Operation } from '@oremedia/contracts/creative';
import { changedElementIds } from './reduce';

/**
 * Spec 21.4: on STALE_REVISION the client re-applies its local intents to the new head when they do not conflict;
 * the same element touched by both sides is a conflict shown to the user. Operations are intents (setText,
 * moveElement, …), so a non-conflicting local operation is valid against the new head unchanged.
 */
export interface RebaseConflict {
  elementId: string;
  localOp: Operation;
  remoteOp: Operation;
}

export type RebaseResult = { ok: true; operations: Operation[] } | { ok: false; conflicts: RebaseConflict[] };

/** Page ids an operation touches as a whole (applyTemplate replaces every element on its page; addPage owns the page id). */
const pageScope = (op: Operation): string | null => {
  if (op.op === 'applyTemplate') return op.pageId;
  if (op.op === 'addPage') return op.page.id;
  return null;
};

const pageOfOp = (op: Operation): string | null => {
  if ('pageId' in op) return op.pageId;
  if (op.op === 'addPage') return op.page.id;
  if (op.op === 'createFormatVariant') return op.sourcePageId;
  return null;
};

export function rebaseBatch(localOps: Operation[], serverOpsSinceBase: Operation[][]): RebaseResult {
  const remoteByElement = new Map<string, Operation>();
  const remoteByPage = new Map<string, Operation>();
  for (const batch of serverOpsSinceBase)
    for (const op of batch) {
      for (const id of changedElementIds({ operations: [op] }))
        if (!remoteByElement.has(id)) remoteByElement.set(id, op);
      const scope = pageScope(op);
      if (scope && !remoteByPage.has(scope)) remoteByPage.set(scope, op);
    }

  const conflicts: RebaseConflict[] = [];
  for (const localOp of localOps) {
    const ids = changedElementIds({ operations: [localOp] });
    for (const id of ids) {
      const remoteOp = remoteByElement.get(id);
      if (remoteOp) conflicts.push({ elementId: id, localOp, remoteOp });
    }
    // A remote page-level replacement invalidates every local intent on that page, and a local one every remote edit.
    const page = pageOfOp(localOp);
    const remotePage = page ? remoteByPage.get(page) : undefined;
    if (remotePage && !ids.some((id) => remoteByElement.get(id) === remotePage))
      conflicts.push({ elementId: ids[0] ?? page ?? '', localOp, remoteOp: remotePage });
    const localScope = pageScope(localOp);
    if (localScope)
      for (const [id, remoteOp] of remoteByElement)
        if (pageOfOp(remoteOp) === localScope && !ids.includes(id))
          conflicts.push({ elementId: id, localOp, remoteOp });
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, operations: localOps.map((op) => structuredClone(op)) };
}
