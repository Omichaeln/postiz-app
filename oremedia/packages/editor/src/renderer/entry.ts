import Konva from 'konva';
import type { RenderInput, RenderOutput } from './protocol';
import { buildScene } from './scene';
import { RENDERER_VERSION } from './version';

/**
 * Spec 11.5: the render-only bundle the worker loads into a headless Chromium page (built by
 * tsup.renderer.config.ts into dist/renderer.iife.js). It exposes one function, window.__oremediaRender, that takes
 * everything already resolved (fonts and assets as data: URLs, the page, the format, the brand colours) so the page
 * never fetches anything: the worker has no network egress except the object store (spec 11.5 render isolation).
 * Fonts are registered under the family the caller names (the worker uses the font asset version id), so the
 * document's font refs map to pinned assets, never to system fonts. Input/output types: ./protocol.ts.
 */
async function registerFonts(fonts: RenderInput['fonts']): Promise<void> {
  await Promise.all(
    fonts.map(async (f) => {
      // A variable font covers the whole weight range; a static one is declared the same way so every weight
      // resolves to this pinned file (synthesised bold is deterministic; a system font is not pinned).
      const face = new FontFace(f.family, `url(${f.url})`, { weight: '100 900' });
      document.fonts.add(face);
      await face.load();
    }),
  );
  await document.fonts.ready;
}

export async function render(input: RenderInput): Promise<RenderOutput> {
  await registerFonts(input.fonts);
  Konva.pixelRatio = 1;
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-100000px';
  container.style.top = '0';
  document.body.appendChild(container);
  const stage = new Konva.Stage({ container, width: input.format.width, height: input.format.height });
  const layer = new Konva.Layer({ listening: false });
  stage.add(layer);
  try {
    const handle = buildScene(layer, input.page, {
      format: input.format,
      resolveAssetUrl: (id) => input.assets[id] ?? null,
      fontFamilyFor: (ref) => (input.fonts.some((f) => f.family === ref) ? ref : null),
      colourFor: (token) => input.colours[token] ?? null,
    });
    await handle.ready();
    layer.draw();
    const dataUrl = stage.toDataURL({ mimeType: 'image/png', pixelRatio: 1 });
    const metrics = handle.metrics();
    handle.destroy();
    return { dataUrl, metrics, rendererVersion: RENDERER_VERSION };
  } finally {
    stage.destroy();
    container.remove();
  }
}

declare global {
  interface Window {
    __oremediaRender: (input: RenderInput) => Promise<RenderOutput>;
    /** For the golden "web path" (spec 19.5): the same scene builder driven on a visible stage. */
    __oremediaRenderer: { Konva: typeof Konva; buildScene: typeof buildScene; version: string };
  }
}

window.__oremediaRender = render;
window.__oremediaRenderer = { Konva, buildScene, version: RENDERER_VERSION };
