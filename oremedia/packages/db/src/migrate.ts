import { migrate } from 'drizzle-orm/mysql2/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closeDatabase, configureDatabase } from './client';

/**
 * Runs versioned migrations (drizzle-kit generate output). This is the only supported way to change the schema.
 * `prisma db push --accept-data-loss`-style pushes are prohibited (spec 2.1.11, 20.4 R6).
 */
export async function runMigrations(url: string, opts: { migrationsFolder?: string } = {}): Promise<void> {
  const db = configureDatabase({ url, connectionLimit: 2 });
  await migrate(db, { migrationsFolder: opts.migrationsFolder ?? migrationsFolder() });
}

/** Bundled builds ship the SQL files next to the bundle and set OREMEDIA_MIGRATIONS_DIR. */
export const migrationsFolder = (): string =>
  process.env['OREMEDIA_MIGRATIONS_DIR'] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  runMigrations(url)
    .then(async () => {
      await closeDatabase();
      console.error('migrations applied');
    })
    .catch(async (err) => {
      console.error(err);
      await closeDatabase();
      process.exit(1);
    });
}
