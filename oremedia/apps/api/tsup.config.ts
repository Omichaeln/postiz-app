import { cp } from 'node:fs/promises';
import { defineConfig } from 'tsup';

/**
 * Workspace packages are inlined (their sources are TypeScript); every third-party package stays external and is
 * resolved at runtime from the flat production node_modules the image build installs (infra/railway/Dockerfile).
 * Native and worker-thread packages (sharp, pino transports) must never be bundled.
 */
export default defineConfig({
  entry: { main: 'src/main.ts', migrate: 'src/migrate.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@oremedia\//],
  skipNodeModulesBundle: true,
  // Migrations (SQL + drizzle journal) are read from disk at runtime; ship them next to the bundle. A function is
  // awaited by tsup, whereas a shell string is not and can be cut off before the copy finishes.
  onSuccess: async () => {
    await cp('../../packages/db/migrations', 'dist/migrations', { recursive: true });
  },
});
