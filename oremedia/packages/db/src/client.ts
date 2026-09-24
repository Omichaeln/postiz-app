/**
 * The raw Drizzle handle. Importable ONLY inside packages/db (ESLint oremedia/no-raw-db).
 * Feature code extends TenantScopedRepository; platform code uses PlatformRepository; the outbox
 * dispatcher is the single path-allowlisted exception (spec 14.2).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
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

const createPool = (cfg: DatabaseConfig): mysql.Pool =>
  mysql.createPool({
    uri: cfg.url,
    connectionLimit: cfg.connectionLimit ?? 10,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: false,
    timezone: 'Z',
  });

export function configureDatabase(cfg: DatabaseConfig): Db {
  if (pool) void pool.end();
  pool = createPool(cfg);
  handle = drizzle(pool, { schema, mode: 'default' });
  return handle;
}

/**
 * Database roles with narrower grants than the application role, each on its own pool (spec 6.1 / 17.5). Only
 * `retention`: roles/retention-role.sql, configured from DATABASE_URL_RETENTION by the worker that hosts
 * retentionSweepWorkflowV1 and entered only by that workflow's activities (runWithDatabaseRole).
 */
export type DatabaseRole = 'retention';

const rolePools = new Map<DatabaseRole, { pool: mysql.Pool; handle: Db }>();
const roleScope = new AsyncLocalStorage<Db>();

export function configureRoleDatabase(role: DatabaseRole, cfg: DatabaseConfig): Db {
  const previous = rolePools.get(role);
  if (previous) void previous.pool.end();
  const p = createPool(cfg);
  const h = drizzle(p, { schema, mode: 'default' });
  rolePools.set(role, { pool: p, handle: h });
  return h;
}

/**
 * Runs fn with every repository and transaction on the role's connection. When the role has no connection
 * configured (local development, tests on a root connection) fn runs on the application connection, which the
 * engine then holds to the application role's grants.
 */
export function runWithDatabaseRole<T>(role: DatabaseRole, fn: () => Promise<T>): Promise<T> {
  const configured = rolePools.get(role);
  return configured ? roleScope.run(configured.handle, fn) : fn();
}

export function getDb(): Db {
  const scoped = roleScope.getStore();
  if (scoped) return scoped;
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
  for (const r of rolePools.values()) await r.pool.end();
  rolePools.clear();
}

export { schema };
