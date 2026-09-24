import { describe, expect, it } from 'vitest';
import type { Operation } from '@oremedia/contracts/creative';
import { applyBatch, findElement, rebaseBatch } from '@oremedia/editor';
import { fixtureDocument, ids } from '@oremedia/editor/fixtures';
import {
  dropConflicting,
  hasLocalWork,
  initialStudioState,
  localDocument,
  studioReducer,
} from './studio-reducer';
import { diffDocuments, stableJson } from './diff';
import type { Committed } from './types';

const P = 'page_1';
const committed = (n = 1): Committed => {
  const snapshot = fixtureDocument();
  return { revisionId: `rev_${n}`, number: n, snapshot, contentHash: stableJson(snapshot).length.toString() };
};
const setText = (text: string): Operation => ({ op: 'setText', pageId: P, elementId: ids.headline, text });
const move: Operation = { op: 'moveElement', pageId: P, elementId: ids.image, x: 1, y: 1 };

describe('studio state machine (spec 21.4)', () => {
  it('renders committed + pending locally and flushes the pending batch as one intent', () => {
    let s = initialStudioState(committed());
    s = studioReducer(s, {
      type: 'intent',
      batch: { operations: [setText('A')], summary: 'Edit', origin: 'user' },
      key: 'k1',
    });
    s = studioReducer(s, {
      type: 'intent',
      batch: { operations: [move], summary: 'Move Hero', origin: 'user' },
      key: 'k2',
    });
    expect(s.save.kind).toBe('pending');
    expect(s.pending?.key).toBe('k2');
    expect(findElement(localDocument(s).doc.pages[0]!, ids.headline)).toMatchObject({ text: 'A' });
    s = studioReducer(s, { type: 'commit:start', mode: 'autosave' });
    expect(s.pending).toBeNull();
    expect(s.inFlight?.baseRevisionId).toBe('rev_1');
    expect(s.save.kind).toBe('saving');
    // Edits during the flight queue behind it and still render.
    s = studioReducer(s, {
      type: 'intent',
      batch: { operations: [setText('B')], summary: 'Edit', origin: 'user' },
      key: 'k3',
    });
    expect(findElement(localDocument(s).doc.pages[0]!, ids.headline)).toMatchObject({ text: 'B' });
    const next = {
      ...committed(2),
      snapshot: applyBatch(fixtureDocument(), { operations: [setText('A'), move] }),
    };
    s = studioReducer(s, { type: 'commit:success', revision: next, findings: [] });
    expect(s.committed.revisionId).toBe('rev_2');
    expect(s.undo.length).toBe(1);
    expect(s.save.kind).toBe('pending');
    expect(hasLocalWork(s)).toBe(true);
  });

  it('a failed flush returns the batch to pending with the same key so the retry replays', () => {
    let s = initialStudioState(committed());
    s = studioReducer(s, {
      type: 'intent',
      batch: { operations: [move], summary: 'Move', origin: 'user' },
      key: 'k1',
    });
    s = studioReducer(s, { type: 'commit:start', mode: 'autosave' });
    s = studioReducer(s, {
      type: 'commit:failed',
      key: 'unused',
      error: {
        kind: 'network',
        code: 'NETWORK',
        message: 'offline',
        correlationId: null,
        details: [],
        retryAfterMs: null,
      },
    });
    expect(s.save.kind).toBe('failed');
    expect(s.pending?.key).toBe('k1');
    expect(s.inFlight).toBeNull();
  });

  it('STALE_REVISION: non-conflicting intents are re-applied on the new head as a new intent', () => {
    let s = initialStudioState(committed());
    s = studioReducer(s, {
      type: 'intent',
      batch: { operations: [move], summary: 'Move', origin: 'user' },
      key: 'k1',
    });
    s = studioReducer(s, { type: 'commit:start', mode: 'autosave' });
    s = studioReducer(s, { type: 'commit:stale' });
    expect(s.save.kind).toBe('rebasing');
    const remote = [setText('Remote')];
    const head = { ...committed(2), snapshot: applyBatch(fixtureDocument(), { operations: remote }) };
    const rebased = rebaseBatch(s.inFlight!.operations, [remote]);
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    s = studioReducer(s, { type: 'rebase:applied', head, operations: rebased.operations, key: 'k2' });
    expect(s.committed.revisionId).toBe('rev_2');
    expect(s.pending?.key).toBe('k2');
    const doc = localDocument(s).doc.pages[0]!;
    expect(findElement(doc, ids.headline)).toMatchObject({ text: 'Remote' });
    expect(findElement(doc, ids.image)?.transform).toMatchObject({ x: 1, y: 1 });
  });

  it('STALE_REVISION with a conflict: keep-server drops only the conflicting local ops', () => {
    let s = initialStudioState(committed());
    const local = [setText('Local'), move];
    s = studioReducer(s, {
      type: 'intent',
      batch: { operations: local, summary: 'Edit', origin: 'user' },
      key: 'k1',
    });
    s = studioReducer(s, { type: 'commit:start', mode: 'autosave' });
    const remote = [setText('Remote')];
    const head = { ...committed(2), snapshot: applyBatch(fixtureDocument(), { operations: remote }) };
    const rebased = rebaseBatch(local, [remote]);
    expect(rebased.ok).toBe(false);
    if (rebased.ok) return;
    s = studioReducer(s, { type: 'rebase:conflict', head, localOps: local, conflicts: rebased.conflicts });
    expect(s.save.kind).toBe('conflict');
    expect(s.conflict?.conflicts[0]?.elementId).toBe(ids.headline);
    expect(dropConflicting(local, rebased.conflicts)).toEqual([move]);
    const kept = studioReducer(s, { type: 'conflict:keep-server', key: 'k2' });
    expect(kept.conflict).toBeNull();
    expect(kept.pending?.operations).toEqual([move]);
    expect(findElement(localDocument(kept).doc.pages[0]!, ids.headline)).toMatchObject({ text: 'Remote' });
    const discarded = studioReducer(s, { type: 'conflict:discard-all' });
    expect(discarded.pending).toBeNull();
    expect(discarded.committed.revisionId).toBe('rev_2');
  });

  it('undo and redo move history entries and never rewrite it', () => {
    let s = initialStudioState(committed());
    s = studioReducer(s, {
      type: 'intent',
      batch: { operations: [setText('A')], summary: 'Edit', origin: 'user' },
      key: 'k1',
    });
    s = studioReducer(s, { type: 'commit:start', mode: 'autosave' });
    s = studioReducer(s, { type: 'commit:success', revision: committed(2), findings: [] });
    const entry = s.undo[0]!;
    s = studioReducer(s, {
      type: 'commit:start',
      mode: 'undo',
      operations: [setText('October offer')],
      summary: `Undo ${entry.summary}`,
      key: 'k2',
      origin: 'user',
    });
    s = studioReducer(s, { type: 'commit:success', revision: committed(3), findings: [] });
    expect(s.undo.length).toBe(0);
    expect(s.redo.length).toBe(1);
    expect(s.redo[0]?.operations).toEqual([setText('October offer')]);
    s = studioReducer(s, {
      type: 'commit:start',
      mode: 'redo',
      operations: [setText('A')],
      summary: 'Redo',
      key: 'k3',
      origin: 'user',
    });
    s = studioReducer(s, { type: 'commit:success', revision: committed(4), findings: [] });
    expect(s.undo.length).toBe(1);
    expect(s.redo.length).toBe(0);
  });

  it('a proposal can be modified into the pending batch or cleared', () => {
    let s = initialStudioState(committed());
    const batch = {
      operations: [setText('Proposed')],
      summary: 'Agent: shorten headline',
      origin: 'agent' as const,
    };
    s = studioReducer(s, {
      type: 'proposal:set',
      proposal: {
        id: 'p1',
        batch,
        baseRevisionId: 'rev_1',
        source: 'simulated',
        result: {
          baseRevisionId: 'rev_1',
          snapshot: applyBatch(fixtureDocument(), batch),
          contentHash: 'x',
          findings: [],
          changedElementIds: [ids.headline],
          blocking: false,
          preview: { kind: 'scene', rendererVersion: '1.0.0', publishable: false, pages: [] },
        },
      },
    });
    expect(s.proposal?.id).toBe('p1');
    const modified = studioReducer(s, { type: 'proposal:modify', key: 'k9' });
    expect(modified.proposal).toBeNull();
    expect(modified.pending?.operations).toEqual(batch.operations);
    expect(studioReducer(s, { type: 'proposal:clear' }).proposal).toBeNull();
  });

  it('diffDocuments reports added, changed and removed elements for the overlay', () => {
    const before = fixtureDocument();
    const after = applyBatch(before, {
      operations: [
        setText('Changed'),
        { op: 'removeElement', pageId: P, elementId: ids.body },
        {
          op: 'insertElement',
          pageId: P,
          element: { ...before.pages[0]!.elements[3]!, id: 'el_00000000000000000000000001', name: 'New' },
        },
      ],
    });
    const diff = diffDocuments(before, after);
    expect(diff.map((d) => `${d.kind}:${d.element.name}`).sort()).toEqual([
      'added:New',
      'changed:Headline',
      'removed:Body',
    ]);
  });
});

describe('coalesce', () => {
  it('collapses consecutive same-kind edits of one element into a single operation', () => {
    let s = initialStudioState(committed());
    for (const t of ['O', 'Oc', 'Oct'])
      s = studioReducer(s, {
        type: 'intent',
        batch: { operations: [setText(t)], summary: 'Edit', origin: 'user' },
        key: t,
      });
    s = studioReducer(s, {
      type: 'intent',
      batch: { operations: [move], summary: 'Move', origin: 'user' },
      key: 'm',
    });
    s = studioReducer(s, {
      type: 'intent',
      batch: {
        operations: [{ op: 'setStyle', pageId: P, elementId: ids.body, patch: { sizePx: 30 } }],
        summary: 'Style',
        origin: 'user',
      },
      key: 's1',
    });
    s = studioReducer(s, {
      type: 'intent',
      batch: {
        operations: [{ op: 'setStyle', pageId: P, elementId: ids.body, patch: { align: 'center' } }],
        summary: 'Style',
        origin: 'user',
      },
      key: 's2',
    });
    expect(s.pending?.operations).toEqual([
      setText('Oct'),
      move,
      { op: 'setStyle', pageId: P, elementId: ids.body, patch: { sizePx: 30, align: 'center' } },
    ]);
  });
});
