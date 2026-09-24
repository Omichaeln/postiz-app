import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

/**
 * Same layout as apps/api: workspace packages inlined, third-party packages external (infra/railway/Dockerfile).
 * After the bundle, the Temporal workflow code of each task queue this worker hosts is pre-bundled with
 * bundleWorkflowCode from the per-queue entry files in packages/workflows/src/queues (production images carry no
 * sources; the worker passes workflowBundle: { codePath } to Worker.create), as apps/worker-render does.
 */
const QUEUES = ['ingest'] as const;

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
  },
});
