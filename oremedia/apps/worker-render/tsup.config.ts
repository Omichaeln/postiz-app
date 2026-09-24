import { cp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { defineConfig } from 'tsup';

/**
 * Mirrors apps/api: workspace packages are inlined, every third-party package stays external (playwright, sharp and
 * the Temporal core bridge are native/worker-thread packages that must never be bundled). main.js is the
 * dependency-free configuration gate that imports worker.js at runtime. After the worker bundle:
 *  1. the Temporal workflow code of each task queue is pre-bundled with bundleWorkflowCode from the per-queue entry
 *     files in packages/workflows/src/queues (production images carry no sources; the worker passes
 *     workflowBundle: { codePath } to Worker.create);
 *  2. the render-only editor bundle is copied next to main.js. The image build must therefore run
 *     `pnpm --filter @oremedia/editor build:renderer` before `pnpm --filter @oremedia/worker-render build`.
 */
const QUEUES = ['render', 'media'] as const;

export default defineConfig({
  entry: { main: 'src/main.ts', worker: 'src/worker.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@oremedia\//],
  skipNodeModulesBundle: true,
  onSuccess: async () => {
    const require = createRequire(join(process.cwd(), 'package.json'));
    const { bundleWorkflowCode } = await import('@temporalio/worker');
    for (const queue of QUEUES) {
      const workflowsPath = require.resolve(`@oremedia/workflows/queues/${queue}`);
      const { code } = await bundleWorkflowCode({ workflowsPath });
      await writeFile(`dist/workflows.${queue}.js`, code);
    }
    const editorVersion = require.resolve('@oremedia/editor/renderer/version');
    const renderer = resolve(dirname(editorVersion), '../../dist/renderer.iife.js');
    if (!existsSync(renderer))
      throw new Error(`${renderer} is missing: run \`pnpm --filter @oremedia/editor build:renderer\` first`);
    await cp(renderer, 'dist/renderer.iife.js');
  },
});
