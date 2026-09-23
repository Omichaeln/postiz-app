import { defineConfig } from 'tsup';

/** Workspace packages are bundled; third-party dependencies stay external and come from `pnpm deploy`. */
export default defineConfig({
  entry: { main: 'src/main.ts', migrate: 'src/migrate.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  noExternal: [/^@oremedia\//],
  // Migrations are read from disk at runtime relative to the db package; copy them next to the bundle.
  onSuccess: 'mkdir -p dist/migrations && cp -r ../../packages/db/migrations/. dist/migrations/',
});
