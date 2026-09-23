/**
 * The raw Drizzle handle. Importable ONLY inside packages/db (ESLint oremedia/no-raw-db).
 * Feature code extends TenantScopedRepository; platform code uses PlatformRepository; the outbox
 * dispatcher is the single path-allowlisted exception (spec 14.2).
 */
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import * as schema from './schema';

export type Db = MySql2Database<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

let pool: mysql.Pool | null = null;
let handle: Db | null = null;

export interface DatabaseConfig {
  url: string;
  connectionLimit?: number;
}

export function configureDatabase(cfg: DatabaseConfig): Db {
  if (pool) void pool.end();
  pool = mysql.createPool({
    uri: cfg.url,
    connectionLimit: cfg.connectionLimit ?? 10,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: false,
    timezone: 'Z',
  });
  handle = drizzle(pool, { schema, mode: 'default' });
  return handle;
}

export function getDb(): Db {
  if (!handle) {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is not configured');
    return configureDatabase({ url });
  }
  return handle;
}

export async function closeDatabase(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
  handle = null;
}

export { schema };
