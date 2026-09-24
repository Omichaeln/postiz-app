import { defineConfig } from 'tsup';

/** Same layout as apps/api: workspace packages inlined, third-party packages external (infra/railway/Dockerfile). */
export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@oremedia\//],
  skipNodeModulesBundle: true,
});
