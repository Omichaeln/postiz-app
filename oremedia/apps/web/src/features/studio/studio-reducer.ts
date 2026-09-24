import type { CreativeDocumentV1, Finding, Operation } from '@oremedia/contracts/creative';
import {
  applyBatch,
  changedElementIds,
  type IntentBatch,
  type RebaseConflict,
  type TemplateDocument,
} from '@oremedia/editor';
import type { UiError } from '../../lib/errors';
import type { Committed, CommitMode, HistoryEntry, Proposal, StudioState } from './types';

/**
 * Spec 21.4 as a pure state machine: the canvas renders the committed revision plus the local pending batch; the
 * pending batch is flushed on debounce or explicit save; STALE_REVISION leads to a rebase or a conflict. Everything
 * asynchronous (the tRPC calls) lives in use-studio.ts and only dispatches here.
 */
export type StudioAction =
  | { type: 'intent'; batch: IntentBatch; key: string }
  | { type: 'commit:start'; mode: 'autosave'; key?: string }
  | {
      type: 'commit:start';
      mode: 'undo' | 'redo' | 'proposal';
      operations: Operation[];
      summary: string;
      key: string;
      origin: 'user' | 'agent';
    }
  | { type: 'commit:success'; revision: Committed; findings: Finding[] }
  | { type: 'commit:failed'; error: UiError; key: string }
  | { type: 'commit:stale' }
  | { type: 'rebase:applied'; head: Committed; operations: Operation[]; key: string }
  | { type: 'rebase:conflict'; head: Committed; localOps: Operation[]; conflicts: RebaseConflict[] }
  | { type: 'conflict:keep-server'; key: string }
  | { type: 'conflict:discard-all' }
  | { type: 'head:refresh'; head: Committed }
  | { type: 'select'; ids: string[] }
  | { type: 'page'; id: string }
  | { type: 'template:resolved'; templateVersionId: string; template: TemplateDocument }
  | { type: 'proposal:set'; proposal: Proposal }
  | { type: 'proposal:modify'; key: string }
  | { type: 'proposal:clear' }
  | { type: 'notice'; notice: StudioState['notice'] };

export function initialStudioState(committed: Committed): StudioState {
  return {
    committed,
    pending: null,
    inFlight: null,
    save: { kind: 'saved', at: Date.now() },
    conflict: null,
    proposal: null,
    undo: [],
    redo: [],
    findings: [],
    selection: [],
    pageId: committed.snapshot.pages[0]?.id ?? '',
    templates: {},
    notice: null,
  };
}

const joinSummary = (a: string | undefined, b: string): string => {
  if (!a) return b;
  if (a === b || a.endsWith(b)) return a;
  const next = `${a}; ${b}`;
  return next.length > 500 ? next.slice(next.length - 500) : next;
};

/**
 * Consecutive edits of the same kind on the same element collapse into one operation (a text field dispatching per
 * keystroke stays one setText; a drag preview stays one moveElement), so a pending batch stays small and readable.
 */
export function coalesce(operations: Operation[], next: Operation): Operation[] {
  const last = operations[operations.length - 1];
  if (
    last &&
    'elementId' in last &&
    'elementId' in next &&
    last.elementId === next.elementId &&
    last.pageId === next.pageId
  ) {
    if (
      (last.op === 'setText' && next.op === 'setText') ||
      (last.op === 'moveElement' && next.op === 'moveElement') ||
      (last.op === 'resizeElement' && next.op === 'resizeElement') ||
      (last.op === 'setCrop' && next.op === 'setCrop')
    )
      return [...operations.slice(0, -1), next];
    if (last.op === 'setStyle' && next.op === 'setStyle')
      return [...operations.slice(0, -1), { ...next, patch: { ...last.patch, ...next.patch } }];
  }
  return [...operations, next];
}

const restStatus = (s: StudioState): StudioState['save'] =>
  s.pending ? { kind: 'pending' } : { kind: 'saved', at: Date.now() };

/** Local ops that touch none of the conflicting elements survive a "keep the server version" resolution. */
export function dropConflicting(localOps: Operation[], conflicts: RebaseConflict[]): Operation[] {
  const conflictingOps = new Set(conflicts.map((c) => c.localOp));
  const ids = new Set(conflicts.map((c) => c.elementId));
  return localOps.filter(
    (op) => !conflictingOps.has(op) && !changedElementIds({ operations: [op] }).some((id) => ids.has(id)),
  );
}

export function studioReducer(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'intent': {
      const pending = state.pending
        ? {
            operations: action.batch.operations.reduce(coalesce, state.pending.operations),
            summary: joinSummary(state.pending.summary, action.batch.summary),
            key: action.key,
          }
        : { operations: [...action.batch.operations], summary: action.batch.summary, key: action.key };
      return {
        ...state,
        pending,
        save: state.inFlight ? state.save : state.conflict ? state.save : { kind: 'pending' },
        redo: [],
        notice: null,
      };
    }
    case 'commit:start': {
      if (state.inFlight) return state;
      if (action.mode === 'autosave') {
        if (!state.pending) return state;
        return {
          ...state,
          pending: null,
          inFlight: {
            ...state.pending,
            key: action.key ?? state.pending.key,
            baseRevisionId: state.committed.revisionId,
            before: state.committed.snapshot,
            mode: 'autosave',
            origin: 'user',
          },
          save: { kind: 'saving' },
        };
      }
      return {
        ...state,
        inFlight: {
          operations: action.operations,
          summary: action.summary,
          key: action.key,
          baseRevisionId: state.committed.revisionId,
          before: state.committed.snapshot,
          mode: action.mode,
          origin: action.origin,
        },
        save: { kind: 'saving' },
      };
    }
    case 'commit:success': {
      const inFlight = state.inFlight;
      if (!inFlight) return { ...state, committed: action.revision, findings: action.findings };
      const entry: HistoryEntry = {
        before: inFlight.before,
        operations: inFlight.operations,
        summary: inFlight.summary,
      };
      const history = historyAfter(state, inFlight.mode, entry);
      return {
        ...state,
        ...history,
        committed: action.revision,
        inFlight: null,
        findings: action.findings,
        proposal: inFlight.mode === 'proposal' ? null : state.proposal,
        save: restStatus(state),
      };
    }
    case 'commit:failed': {
      const inFlight = state.inFlight;
      if (!inFlight) return { ...state, save: { kind: 'failed', error: action.error } };
      // The batch goes back to pending so a retry replays the same intent (same key when nothing else changed).
      const merged = state.pending
        ? {
            operations: [...inFlight.operations, ...state.pending.operations],
            summary: joinSummary(inFlight.summary, state.pending.summary),
            key: action.key,
          }
        : { operations: inFlight.operations, summary: inFlight.summary, key: inFlight.key };
      return {
        ...state,
        inFlight: null,
        pending: inFlight.mode === 'autosave' || inFlight.mode === 'proposal' ? merged : state.pending,
        save: { kind: 'failed', error: action.error },
        notice:
          inFlight.mode === 'undo' || inFlight.mode === 'redo'
            ? {
                tone: 'critical',
                text: `${inFlight.mode === 'undo' ? 'Undo' : 'Redo'} was not saved: ${action.error.message}`,
              }
            : state.notice,
      };
    }
    case 'commit:stale':
      return { ...state, save: { kind: 'rebasing' } };
    case 'rebase:applied': {
      const rest = state.pending?.operations ?? [];
      const operations = [...action.operations, ...rest];
      return {
        ...state,
        committed: action.head,
        inFlight: null,
        pending:
          operations.length > 0
            ? {
                operations,
                summary: joinSummary(state.inFlight?.summary, state.pending?.summary ?? ''),
                key: action.key,
              }
            : null,
        undo: [],
        redo: [],
        conflict: null,
        save: operations.length > 0 ? { kind: 'pending' } : { kind: 'saved', at: Date.now() },
        notice: {
          tone: 'info',
          text: `Rebased onto revision ${action.head.number}: your changes were re-applied.`,
        },
      };
    }
    case 'rebase:conflict':
      return {
        ...state,
        inFlight: null,
        pending: null,
        conflict: { head: action.head, localOps: action.localOps, conflicts: action.conflicts },
        save: { kind: 'conflict' },
      };
    case 'conflict:keep-server': {
      if (!state.conflict) return state;
      const kept = dropConflicting(state.conflict.localOps, state.conflict.conflicts);
      return {
        ...state,
        committed: state.conflict.head,
        conflict: null,
        pending:
          kept.length > 0
            ? { operations: kept, summary: 'Re-applied after conflict', key: action.key }
            : null,
        undo: [],
        redo: [],
        save: kept.length > 0 ? { kind: 'pending' } : { kind: 'saved', at: Date.now() },
        notice: {
          tone: 'info',
          text: `Kept the server version for ${state.conflict.conflicts.length} element${state.conflict.conflicts.length === 1 ? '' : 's'}; ${kept.length} of your changes re-applied.`,
        },
      };
    }
    case 'conflict:discard-all':
      if (!state.conflict) return state;
      return {
        ...state,
        committed: state.conflict.head,
        conflict: null,
        pending: null,
        undo: [],
        redo: [],
        save: { kind: 'saved', at: Date.now() },
        notice: {
          tone: 'info',
          text: `Discarded your local changes; showing revision ${state.conflict.head.number}.`,
        },
      };
    case 'head:refresh':
      if (state.pending || state.inFlight || state.conflict) return state;
      if (action.head.revisionId === state.committed.revisionId) return state;
      return { ...state, committed: action.head, undo: [], redo: [] };
    case 'select':
      return { ...state, selection: action.ids };
    case 'page':
      return state.pageId === action.id ? state : { ...state, pageId: action.id, selection: [] };
    case 'template:resolved':
      return { ...state, templates: { ...state.templates, [action.templateVersionId]: action.template } };
    case 'proposal:set':
      return { ...state, proposal: action.proposal };
    case 'proposal:modify': {
      if (!state.proposal) return state;
      const ops = state.proposal.batch.operations;
      return {
        ...state,
        proposal: null,
        pending: {
          operations: [...(state.pending?.operations ?? []), ...ops],
          summary: joinSummary(state.pending?.summary, state.proposal.batch.summary),
          key: action.key,
        },
        save: state.inFlight ? state.save : { kind: 'pending' },
      };
    }
    case 'proposal:clear':
      return { ...state, proposal: null };
    case 'notice':
      return { ...state, notice: action.notice };
  }
}

function historyAfter(
  state: StudioState,
  mode: CommitMode,
  entry: HistoryEntry,
): Pick<StudioState, 'undo' | 'redo'> {
  switch (mode) {
    case 'autosave':
    case 'proposal':
      return { undo: [...state.undo, entry].slice(-50), redo: [] };
    case 'undo':
      return { undo: state.undo.slice(0, -1), redo: [...state.redo, entry].slice(-50) };
    case 'redo':
      return { undo: [...state.undo, entry].slice(-50), redo: state.redo.slice(0, -1) };
  }
}

/** The document the canvas shows: committed + in-flight + pending (spec 21.4). Falls back to committed on error. */
export function localDocument(state: StudioState): { doc: CreativeDocumentV1; error: string | null } {
  const operations = [...(state.inFlight?.operations ?? []), ...(state.pending?.operations ?? [])];
  if (operations.length === 0) return { doc: state.committed.snapshot, error: null };
  try {
    return {
      doc: applyBatch(state.committed.snapshot, { operations }, { templates: state.templates }),
      error: null,
    };
  } catch (err) {
    return { doc: state.committed.snapshot, error: err instanceof Error ? err.message : String(err) };
  }
}

export const hasLocalWork = (state: StudioState): boolean =>
  state.pending !== null || state.inFlight !== null || state.conflict !== null;
