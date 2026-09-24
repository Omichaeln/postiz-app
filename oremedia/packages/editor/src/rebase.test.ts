import { describe, expect, it } from 'vitest';
import type { Operation } from '@oremedia/contracts/creative';
import { applyBatch, findElement } from './reduce';
import { rebaseBatch } from './rebase';
import { fixtureDocument, ids } from './fixtures';

const P = 'page_1';

describe('rebaseBatch (spec 21.4: re-apply local intents to the new head unless the same element was touched)', () => {
  it('re-applies non-conflicting local intents on the new head', () => {
    const base = fixtureDocument();
    const remote: Operation[] = [
      { op: 'setText', pageId: P, elementId: ids.headline, text: 'Remote headline' },
    ];
    const local: Operation[] = [{ op: 'moveElement', pageId: P, elementId: ids.image, x: 10, y: 10 }];
    const head = applyBatch(base, { operations: remote });
    const rebased = rebaseBatch(local, [remote]);
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    const merged = applyBatch(head, { operations: rebased.operations });
    const page = merged.pages[0]!;
    expect(findElement(page, ids.headline)).toMatchObject({ text: 'Remote headline' });
    expect(findElement(page, ids.image)?.transform).toMatchObject({ x: 10, y: 10 });
  });

  it('the same element touched by both sides is a conflict naming the element and both operations', () => {
    const remote: Operation[] = [{ op: 'setText', pageId: P, elementId: ids.headline, text: 'Remote' }];
    const local: Operation[] = [
      { op: 'setText', pageId: P, elementId: ids.headline, text: 'Local' },
      { op: 'moveElement', pageId: P, elementId: ids.image, x: 1, y: 1 },
    ];
    const rebased = rebaseBatch(local, [remote]);
    expect(rebased).toEqual({
      ok: false,
      conflicts: [{ elementId: ids.headline, localOp: local[0], remoteOp: remote[0] }],
    });
  });

  it('a remote removal of an element the local batch edits is a conflict (never a silent re-insert)', () => {
    const remote: Operation[][] = [
      [{ op: 'setLock', pageId: P, elementId: ids.logo, locked: true }],
      [{ op: 'removeElement', pageId: P, elementId: ids.body }],
    ];
    const local: Operation[] = [{ op: 'setStyle', pageId: P, elementId: ids.body, patch: { sizePx: 30 } }];
    const rebased = rebaseBatch(local, remote);
    expect(rebased.ok).toBe(false);
    if (rebased.ok) return;
    expect(rebased.conflicts[0]?.remoteOp.op).toBe('removeElement');
  });

  it('a remote applyTemplate conflicts with every local intent on that page', () => {
    const remote: Operation[] = [
      { op: 'applyTemplate', pageId: P, templateVersionId: 'tv_1', slotBindings: { headline: ids.headline } },
    ];
    const local: Operation[] = [{ op: 'moveElement', pageId: P, elementId: ids.image, x: 1, y: 1 }];
    const rebased = rebaseBatch(local, [remote]);
    expect(rebased.ok).toBe(false);
    if (rebased.ok) return;
    expect(rebased.conflicts).toEqual([{ elementId: ids.image, localOp: local[0], remoteOp: remote[0] }]);
  });

  it('a local applyTemplate conflicts with remote edits on that page', () => {
    const remote: Operation[] = [{ op: 'moveElement', pageId: P, elementId: ids.image, x: 1, y: 1 }];
    const local: Operation[] = [
      { op: 'applyTemplate', pageId: P, templateVersionId: 'tv_1', slotBindings: { headline: ids.headline } },
    ];
    const rebased = rebaseBatch(local, [remote]);
    expect(rebased.ok).toBe(false);
    if (rebased.ok) return;
    expect(rebased.conflicts[0]).toMatchObject({ elementId: ids.image });
  });

  it('page-level intents that touch no shared element re-apply cleanly', () => {
    const base = fixtureDocument();
    const remote: Operation[] = [{ op: 'setText', pageId: P, elementId: ids.headline, text: 'Remote' }];
    const local: Operation[] = [{ op: 'createFormatVariant', sourcePageId: P, formatKey: 'ig_story_9x16' }];
    const rebased = rebaseBatch(local, [remote]);
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    const head = applyBatch(base, { operations: remote });
    const merged = applyBatch(head, { operations: rebased.operations });
    expect(merged.pages.length).toBe(2);
    // The variant is reflowed from the NEW head, so it carries the remote edit.
    expect(findElement(merged.pages[1]!, ids.headline)).toMatchObject({ text: 'Remote' });
  });

  it('returns copies so the caller can keep its original pending batch', () => {
    const local: Operation[] = [{ op: 'moveElement', pageId: P, elementId: ids.image, x: 1, y: 1 }];
    const rebased = rebaseBatch(local, []);
    expect(rebased.ok && rebased.operations).toEqual(local);
    expect(rebased.ok && rebased.operations[0]).not.toBe(local[0]);
  });
});
