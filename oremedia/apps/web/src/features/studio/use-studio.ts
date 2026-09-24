import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from 'react-router';
import type { CreativeDocumentV1, CreativePage, Operation } from '@oremedia/contracts/creative';
import {
  applyBatch,
  changedElementIds,
  findElement,
  invertBatch,
  rebaseBatch,
  type IntentBatch,
  type TemplateDocument,
} from '@oremedia/editor';
import { useTRPC, useTRPCClient } from '../../lib/trpc';
import { intentContext, newIntentKey } from '../../lib/intent-key';
import { toUiError } from '../../lib/errors';
import {
  hasLocalWork,
  initialStudioState,
  localDocument,
  studioReducer,
  type StudioAction,
} from './studio-reducer';
import {
  committedOf,
  committedOfRevision,
  type CommitMode,
  type Committed,
  type DocumentDto,
  type StudioState,
} from './types';

export const AUTOSAVE_IDLE_MS = 800;

export interface CommitRequest {
  operations: Operation[];
  summary: string;
  key: string;
  baseRevisionId: string;
  baseNumber: number;
  origin: 'user' | 'agent';
  mode: CommitMode;
}

export interface StudioApi {
  state: StudioState;
  doc: CreativeDocumentV1;
  page: CreativePage | undefined;
  localError: string | null;
  dispatch: React.Dispatch<StudioAction>;
  /** Validates the intent against the local document, then queues it (false when the reducer rejected it). */
  applyIntent: (batch: IntentBatch) => boolean;
  saveNow: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  undoBlocked: string | null;
  redoBlocked: string | null;
  keepServer: () => void;
  discardAll: () => void;
  select: (ids: string[]) => void;
  setPage: (id: string) => void;
  resolveTemplate: (templateId: string, templateVersionId: string) => Promise<TemplateDocument | null>;
  simulateProposal: () => Promise<void>;
  acceptProposal: () => void;
  modifyProposal: () => void;
  rejectProposal: () => void;
  blocker: ReturnType<typeof useBlocker>;
}

/**
 * Spec 21.4 orchestration: the reducer owns the state; this hook runs the asynchronous parts (apply, the rebase
 * fetches, propose) and the autosave timer. The canvas adapter only receives `doc` and emits intents.
 */
export function useStudio(documentId: string, initial: DocumentDto): StudioApi {
  const client = useTRPCClient();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(studioReducer, committedOf(initial), initialStudioState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const local = useMemo(() => localDocument(state), [state]);
  const page = local.doc.pages.find((p) => p.id === state.pageId) ?? local.doc.pages[0];

  const afterCommit = useCallback(
    (revision: Committed, raw: DocumentDto['revision']) => {
      queryClient.setQueryData(trpc.creative.documents.get.queryKey({ documentId }), (old) =>
        old ? { ...old, currentRevisionId: revision.revisionId, revision: raw } : old,
      );
      void queryClient.invalidateQueries(trpc.creative.comments.pathFilter());
      void queryClient.invalidateQueries(trpc.creative.revisions.pathFilter());
    },
    [documentId, queryClient, trpc],
  );

  /** STALE_REVISION: fetch the head and the revisions since our base, rebase, re-apply or surface the conflict. */
  const rebase = useCallback(
    async (localOps: Operation[], baseNumber: number) => {
      try {
        const head = await client.creative.documents.get.query({ documentId });
        const list = await client.creative.revisions.list.query({ documentId, page: { limit: 200 } });
        const since = list.items.filter((r) => r.number > baseNumber).sort((a, b) => a.number - b.number);
        const remoteOps = await Promise.all(
          since.map(async (r) => {
            const rev = await client.creative.revisions.get.query({ documentId, revisionId: r.id });
            return rev.operations.operations;
          }),
        );
        const headCommitted = committedOf(head);
        const result = rebaseBatch(localOps, remoteOps);
        if (!result.ok) {
          dispatch({ type: 'rebase:conflict', head: headCommitted, localOps, conflicts: result.conflicts });
          return;
        }
        try {
          applyBatch(
            headCommitted.snapshot,
            { operations: result.operations },
            { templates: stateRef.current.templates },
          );
        } catch {
          // The intents no longer apply to the head (an element they need is gone): treat every one as a conflict.
          const remote = remoteOps.flat();
          dispatch({
            type: 'rebase:conflict',
            head: headCommitted,
            localOps,
            conflicts: localOps.map((op) => ({
              elementId: changedElementIds({ operations: [op] })[0] ?? '',
              localOp: op,
              remoteOp: remote[0] ?? op,
            })),
          });
          return;
        }
        dispatch({
          type: 'rebase:applied',
          head: headCommitted,
          operations: result.operations,
          key: newIntentKey(),
        });
      } catch (err) {
        dispatch({ type: 'commit:failed', error: toUiError(err), key: newIntentKey() });
      }
    },
    [client, documentId],
  );

  const runCommit = useCallback(
    async (req: CommitRequest) => {
      try {
        const res = await client.creative.operations.applyBatch.mutate(
          {
            documentId,
            baseRevisionId: req.baseRevisionId,
            operations: req.operations,
            summary: req.summary,
            origin: req.origin,
          },
          intentContext(req.key),
        );
        const revision = committedOfRevision(res.revision);
        dispatch({ type: 'commit:success', revision, findings: res.findings });
        afterCommit(revision, res.revision);
      } catch (err) {
        const ui = toUiError(err);
        if (ui.kind === 'stale_revision') {
          dispatch({ type: 'commit:stale' });
          await rebase(req.operations, req.baseNumber);
          return;
        }
        dispatch({ type: 'commit:failed', error: ui, key: newIntentKey() });
      }
    },
    [afterCommit, client, documentId, rebase],
  );

  const flush = useCallback(async () => {
    const s = stateRef.current;
    if (!s.pending || s.inFlight || s.conflict) return;
    const { pending, committed } = s;
    dispatch({ type: 'commit:start', mode: 'autosave' });
    await runCommit({
      operations: pending.operations,
      summary: pending.summary,
      key: pending.key,
      baseRevisionId: committed.revisionId,
      baseNumber: committed.number,
      origin: 'user',
      mode: 'autosave',
    });
  }, [runCommit]);

  // Autosave on idle (spec 21.4); a failed save waits for an explicit retry so it does not hammer the server.
  useEffect(() => {
    if (!state.pending || state.inFlight || state.conflict || state.save.kind === 'failed') return;
    const t = window.setTimeout(() => void flush(), AUTOSAVE_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [state.pending, state.inFlight, state.conflict, state.save.kind, flush]);

  // A flush that finished while more edits queued up: send them after the same idle period (covered above because
  // `pending` changes identity), and warn before the tab closes with local work (spec 21.2).
  const dirty = hasLocalWork(state);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const blocker = useBlocker(dirty);

  const applyIntent = useCallback((batch: IntentBatch): boolean => {
    const s = stateRef.current;
    try {
      applyBatch(localDocument(s).doc, batch, { templates: s.templates });
    } catch (err) {
      dispatch({
        type: 'notice',
        notice: {
          tone: 'warning',
          text: `That change is not possible: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
      return false;
    }
    dispatch({ type: 'intent', batch, key: newIntentKey() });
    return true;
  }, []);

  const history = useCallback(
    (mode: 'undo' | 'redo') => {
      const s = stateRef.current;
      const entry = (mode === 'undo' ? s.undo : s.redo).at(-1);
      if (!entry || hasLocalWork(s)) return;
      const inv = invertBatch(entry.before, { operations: entry.operations }, { templates: s.templates });
      if (!inv.ok) {
        dispatch({
          type: 'notice',
          notice: {
            tone: 'warning',
            text: `Cannot ${mode} "${entry.summary}": ${inv.reason} has no inverse operation.`,
          },
        });
        return;
      }
      const key = newIntentKey();
      const summary = `${mode === 'undo' ? 'Undo' : 'Redo'}: ${entry.summary}`.slice(0, 500);
      dispatch({ type: 'commit:start', mode, operations: inv.operations, summary, key, origin: 'user' });
      void runCommit({
        operations: inv.operations,
        summary,
        key,
        baseRevisionId: s.committed.revisionId,
        baseNumber: s.committed.number,
        origin: 'user',
        mode,
      });
    },
    [runCommit],
  );

  const blockedReason = (stack: StudioState['undo'], verb: string): string | null => {
    if (stack.length === 0) return `Nothing to ${verb}`;
    if (hasLocalWork(state)) return 'Save your pending changes first';
    return null;
  };

  const resolveTemplate = useCallback(
    async (templateId: string, templateVersionId: string): Promise<TemplateDocument | null> => {
      const cached = stateRef.current.templates[templateVersionId];
      if (cached) return cached;
      try {
        const t = await client.creative.templates.get.query({ templateId, templateVersionId });
        const version = t.selectedVersion;
        if (!version) return null;
        const current = localDocument(stateRef.current).doc.pages.find(
          (p) => p.id === stateRef.current.pageId,
        );
        const tpage =
          version.document.pages.find((p) => current && p.formatKey === current.formatKey) ??
          version.document.pages[0];
        if (!tpage) return null;
        const template: TemplateDocument = { page: tpage, slots: version.slots };
        dispatch({ type: 'template:resolved', templateVersionId, template });
        return template;
      } catch (err) {
        dispatch({ type: 'notice', notice: { tone: 'critical', text: toUiError(err).message } });
        return null;
      }
    },
    [client],
  );

  /**
   * Development-only trigger: runs a real `operations.propose` dry run with a small agent batch so the overlay,
   * findings and Accept / Modify / Reject paths can be exercised before the agent runtime (Phase 4) exists.
   */
  const simulateProposal = useCallback(async () => {
    const s = stateRef.current;
    const current =
      localDocument(s).doc.pages.find((p) => p.id === s.pageId) ?? localDocument(s).doc.pages[0];
    if (!current) return;
    const text = current.elements.find((e) => e.type === 'text' && !e.locked && !e.protected);
    if (!text || text.type !== 'text') {
      dispatch({
        type: 'notice',
        notice: { tone: 'info', text: 'Add an unlocked text element to simulate a proposal.' },
      });
      return;
    }
    const batch: IntentBatch = {
      operations: [
        { op: 'setText', pageId: current.id, elementId: text.id, text: `${text.text} — proposed` },
      ],
      summary: 'Simulated agent proposal (development only): append to the headline',
      origin: 'agent',
    };
    try {
      const result = await client.creative.operations.propose.mutate(
        { documentId, baseRevisionId: s.committed.revisionId, ...batch },
        intentContext(newIntentKey()),
      );
      dispatch({
        type: 'proposal:set',
        proposal: {
          id: newIntentKey(),
          batch,
          baseRevisionId: s.committed.revisionId,
          result,
          source: 'simulated',
        },
      });
    } catch (err) {
      dispatch({
        type: 'notice',
        notice: { tone: 'critical', text: `Proposal rejected: ${toUiError(err).message}` },
      });
    }
  }, [client, documentId]);

  const acceptProposal = useCallback(() => {
    const s = stateRef.current;
    const p = s.proposal;
    if (!p || hasLocalWork(s) || p.result.blocking || p.baseRevisionId !== s.committed.revisionId) return;
    const key = newIntentKey();
    dispatch({
      type: 'commit:start',
      mode: 'proposal',
      operations: p.batch.operations,
      summary: p.batch.summary,
      key,
      origin: 'agent',
    });
    void runCommit({
      operations: p.batch.operations,
      summary: p.batch.summary,
      key,
      baseRevisionId: s.committed.revisionId,
      baseNumber: s.committed.number,
      origin: 'agent',
      mode: 'proposal',
    });
  }, [runCommit]);

  return {
    state,
    doc: local.doc,
    page,
    localError: local.error,
    dispatch,
    applyIntent,
    saveNow: flush,
    undo: () => history('undo'),
    redo: () => history('redo'),
    undoBlocked: blockedReason(state.undo, 'undo'),
    redoBlocked: blockedReason(state.redo, 'redo'),
    keepServer: () => dispatch({ type: 'conflict:keep-server', key: newIntentKey() }),
    discardAll: () => dispatch({ type: 'conflict:discard-all' }),
    select: (ids) =>
      dispatch({
        type: 'select',
        ids: ids.filter((id) => page !== undefined && findElement(page, id) !== null),
      }),
    setPage: (id) => dispatch({ type: 'page', id }),
    resolveTemplate,
    simulateProposal,
    acceptProposal,
    modifyProposal: () => dispatch({ type: 'proposal:modify', key: newIntentKey() }),
    rejectProposal: () => dispatch({ type: 'proposal:clear' }),
    blocker,
  };
}
