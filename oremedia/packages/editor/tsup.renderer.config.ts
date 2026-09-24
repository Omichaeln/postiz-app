import { defineConfig } from 'tsup';

/**
 * Spec 11.5: the render-only bundle of packages/editor/src/renderer loaded by the render worker in headless
 * Chromium. One self-contained IIFE (Konva inlined) so the worker injects it with page.addScriptTag({ content })
 * and the page loads nothing over the network. Output: dist/renderer.iife.js (pnpm --filter @oremedia/editor
 * build:renderer); apps/worker-render copies it next to its own bundle at build time.
 */
export default defineConfig({
  entry: { renderer: 'src/renderer/entry.ts' },
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  clean: false,
  sourcemap: false,
  minify: false,
  splitting: false,
  treeshake: true,
  noExternal: [/.*/],
  outExtension: () => ({ js: '.iife.js' }),
});
