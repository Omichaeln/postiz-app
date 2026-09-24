import { describe, expect, it } from 'vitest';
import { CreativeDocumentV1, type Element, type Operation } from '@oremedia/contracts/creative';
import { PolicyDeniedError } from '@oremedia/contracts/errors';
import { guardProtected } from './guard';
import { isInteractive, nudgeIntent } from './konva-adapter';
import { applyBatch, findElement } from './reduce';
import { renderFixtures, type RenderFixture } from './renderer/fixtures';
import { validateAgainstBrand } from './validate';

/**
 * Phase 0 editor bake-off (ledger 0.13; write-up docs/spikes/editor-bake-off.md), the DOM-free half: the two golden
 * fixture brands (Latin/Karla, Arabic/Noto Naskh) are real documents the operation engine accepts, their protected
 * logos are immune to agent operations, and the adapter's keyboard path moves their elements. The browser half
 * (shaping, direction, font loading, overflow, determinism) is apps/worker-render/src/bake-off.integration.test.ts.
 */
const byName = (fixture: RenderFixture, name: string): Element => {
  const walk = (els: Element[]): Element | undefined => {
    for (const el of els) {
      if (el.name === name) return el;
      if (el.type === 'group') {
        const found = walk(el.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  const el = walk(fixture.document.pages[0]!.elements);
  if (!el) throw new Error(`${fixture.key} has no element named ${name}`);
  return el;
};
const logoOf = (f: RenderFixture) => byName(f, f.key.startsWith('latin') ? 'Logo' : 'Mark');
const cases = renderFixtures().map((f) => [f.key, f] as const);

const reasonOf = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof PolicyDeniedError ? e.reason : `not_policy_error:${String(e)}`;
  }
};

describe('editor bake-off on the golden fixture brands (DOM-free)', () => {
  it.each(cases)('%s is a valid CreativeDocumentV1 (element ids are prefixed ULIDs)', (_key, fixture) => {
    expect(() => CreativeDocumentV1.parse(fixture.document)).not.toThrow();
  });

  it.each(cases)(
    '%s: every agent operation on the protected logo is denied; the same operations from a person apply',
    (_key, fixture) => {
      const doc = fixture.document;
      const pageId = doc.pages[0]!.id;
      const logo = logoOf(fixture);
      expect(logo.protected).toBe(true);
      const ops: Operation[] = [
        { op: 'moveElement', pageId, elementId: logo.id, x: 10, y: 10 },
        { op: 'resizeElement', pageId, elementId: logo.id, width: 300, height: 90 },
        { op: 'setStyle', pageId, elementId: logo.id, patch: { opacity: 0.5 } },
        { op: 'replaceAsset', pageId, elementId: logo.id, assetVersionId: 'av_other' },
        { op: 'reorderElement', pageId, elementId: logo.id, toIndex: 0 },
        { op: 'setLock', pageId, elementId: logo.id, locked: true },
        { op: 'removeElement', pageId, elementId: logo.id },
      ];
      for (const op of ops) {
        expect(
          reasonOf(() => guardProtected(doc, op, 'agent')),
          op.op,
        ).toBe('protected_element');
        expect(
          reasonOf(() => guardProtected(doc, op, 'user')),
          op.op,
        ).toBeUndefined();
      }
      const moved = applyBatch(doc, { operations: [ops[0]!] });
      expect(findElement(moved.pages[0]!, logo.id)?.transform).toMatchObject({ x: 10, y: 10 });
    },
  );

  it.each(cases)(
    '%s: the keyboard path nudges the headline (1px, 10px with Shift) and the reducer applies it',
    (_key, fixture) => {
      const page = fixture.document.pages[0]!;
      const headline = byName(fixture, 'Headline');
      expect(isInteractive(headline, false)).toBe(true);
      expect(isInteractive(headline, true)).toBe(false); // read-only studio: no intents
      const right = nudgeIntent(page, headline.id, 1, 0)!;
      const down = nudgeIntent(page, headline.id, 0, 10)!;
      const doc = applyBatch(fixture.document, {
        operations: [...right.operations, ...down.operations],
      });
      // Each intent is relative to the position it was computed from, so the second one wins for y and keeps x.
      expect(findElement(doc.pages[0]!, headline.id)?.transform).toMatchObject({
        x: headline.transform.x,
        y: headline.transform.y + 10,
      });
      const once = applyBatch(fixture.document, right);
      expect(findElement(once.pages[0]!, headline.id)?.transform.x).toBe(headline.transform.x + 1);
      expect(CreativeDocumentV1.safeParse(doc).success).toBe(true);
    },
  );

  it('a child inside a group is reachable by the keyboard path (Latin badge text)', () => {
    const fixture = renderFixtures()[0]!;
    const badgeText = byName(fixture, 'Badge text');
    const intent = nudgeIntent(fixture.document.pages[0]!, badgeText.id, -1, 0)!;
    const doc = applyBatch(fixture.document, intent);
    expect(findElement(doc.pages[0]!, badgeText.id)?.transform.x).toBe(badgeText.transform.x - 1);
  });

  it.each(cases)(
    '%s: the static pre-render overflow estimate only warns (the browser measurement decides)',
    (_key, fixture) => {
      const findings = validateAgainstBrand(fixture.document, fixture.snapshot);
      const overflow = findings.filter((f) => f.code === 'possible_overflow');
      expect(overflow.every((f) => f.severity === 'warning')).toBe(true);
    },
  );

  /**
   * GAP (docs/spikes/editor-bake-off.md): the static contrast check compares text with the page background only, so
   * text over a shape (the Latin badge, the Arabic ribbon) reads 1:1 and is blocking before render, although the
   * render check (colour actually under the text) passes both goldens. It would stop an agent batch on these
   * documents. Expected to fail until validateAgainstBrand looks at what is under the text.
   */
  it.fails.each(cases)(
    'GAP %s: the static brand validation finds nothing blocking on a golden fixture that renders clean',
    (_key, fixture) => {
      const blocking = validateAgainstBrand(fixture.document, fixture.snapshot).filter(
        (f) => f.severity === 'blocking',
      );
      expect(blocking).toEqual([]);
    },
  );
});
