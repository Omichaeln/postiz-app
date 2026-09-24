import { describe, expect, it } from 'vitest';
import {
  fitScale,
  formatForPage,
  isInteractive,
  moveIntent,
  nudgeIntent,
  resizeIntent,
  transformIntent,
} from './konva-adapter';
import { findElement } from './reduce';
import { fixtureDocument, ids } from './fixtures';

const page = () => fixtureDocument().pages[0]!;

/** The stage only reports positions and sizes; this mapping decides which operations a gesture becomes (spec 11.6). */
describe('KonvaEditorAdapter intent mapping (DOM-free)', () => {
  it('drag end becomes moveElement with 2-decimal coordinates; a no-op drag emits nothing', () => {
    expect(moveIntent(page(), ids.image, 100.004, 300.996)).toEqual({
      operations: [{ op: 'moveElement', pageId: 'page_1', elementId: ids.image, x: 100, y: 301 }],
      summary: 'Move Hero',
      origin: 'user',
    });
    expect(moveIntent(page(), ids.image, 80, 260)).toBeNull();
  });

  it('locked and unknown elements never produce intents (the UI mirrors the server guard, never replaces it)', () => {
    expect(moveIntent(page(), ids.bg, 1, 1)).toBeNull();
    expect(resizeIntent(page(), ids.bg, 10, 10)).toBeNull();
    expect(moveIntent(page(), 'el_00000000000000000000000000', 1, 1)).toBeNull();
    expect(isInteractive(findElement(page(), ids.bg)!, false)).toBe(false);
    expect(isInteractive(findElement(page(), ids.image)!, false)).toBe(true);
    expect(isInteractive(findElement(page(), ids.image)!, true)).toBe(false);
  });

  it('arrow-key nudges are 1px or 10px moves from the current position', () => {
    expect(nudgeIntent(page(), ids.headline, 1, 0)?.operations[0]).toMatchObject({ x: 81, y: 80 });
    expect(nudgeIntent(page(), ids.headline, 0, -10)?.operations[0]).toMatchObject({ x: 80, y: 70 });
  });

  it('transform end becomes resizeElement (plus moveElement when the box moved)', () => {
    const both = transformIntent(page(), ids.image, { x: 90, y: 270, width: 800, height: 400 });
    expect(both?.operations.map((o) => o.op)).toEqual(['moveElement', 'resizeElement']);
    expect(both?.summary).toBe('Resize Hero');
    const resizeOnly = transformIntent(page(), ids.image, { x: 80, y: 260, width: 800, height: 400 });
    expect(resizeOnly?.operations).toEqual([
      { op: 'resizeElement', pageId: 'page_1', elementId: ids.image, width: 800, height: 400 },
    ]);
    expect(transformIntent(page(), ids.image, { x: 80, y: 260, width: 920, height: 460 })).toBeNull();
  });

  it('logos keep their aspect ratio whatever the gesture asked for', () => {
    const intent = resizeIntent(page(), ids.logo, 300, 10);
    expect(intent?.operations[0]).toMatchObject({ op: 'resizeElement', width: 300, height: 90 });
  });

  it('sizes never collapse below 1px', () => {
    expect(resizeIntent(page(), ids.image, 0, -5)?.operations[0]).toMatchObject({ width: 1, height: 1 });
  });

  it('fits the page into the viewport without enlarging past 1:1', () => {
    expect(fitScale({ width: 1080, height: 1080 }, { width: 540, height: 800 })).toBe(0.5);
    expect(fitScale({ width: 1080, height: 1920 }, { width: 2000, height: 960 })).toBe(0.5);
    expect(fitScale({ width: 500, height: 500 }, { width: 2000, height: 2000 })).toBe(1);
    expect(fitScale({ width: 500, height: 500 }, { width: 0, height: 0 })).toBe(1);
  });

  it('an unknown format key falls back to the page dimensions with no safe area', () => {
    expect(formatForPage(page()).key).toBe('square_1080');
    expect(formatForPage({ ...page(), formatKey: 'custom' })).toMatchObject({
      key: 'custom',
      width: 1080,
      height: 1080,
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  });
});
