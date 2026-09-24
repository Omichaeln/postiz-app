import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { closeDatabase, configureDatabase, type Db } from '../client';
import { migrationsFolder, runMigrations } from '../migrate';
import { generateRetentionRoleSql, generateRoleSql } from '../roles';

export interface TestDatabase {
  db: Db;
  url: string;
  name: string;
  /** The server's administrative URL (TEST_DATABASE_URL or the container's root). */
  adminUrl: string;
  /** Applies every remaining migration (after `migrationsUpTo`) and reconnects; `db` is the new handle. */
  migrateToHead(): Promise<Db>;
  drop(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** Stop after this migration tag (e.g. `0001_tool_invocation_proposal_payload`): a database at a previous head. */
  migrationsUpTo?: string;
}

/** The versioned migrations up to and including `tag`, as a folder the drizzle migrator accepts. */
async function migrationsUpTo(tag: string): Promise<string> {
  const source = migrationsFolder();
  const journal = JSON.parse(await readFile(path.join(source, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const last = journal.entries.findIndex((e) => e.tag === tag);
  if (last < 0) throw new Error(`no migration ${tag} in ${source}`);
  const entries = journal.entries.slice(0, last + 1);
  const target = await mkdtemp(path.join(tmpdir(), 'oremedia-migrations-'));
  await mkdir(path.join(target, 'meta'));
  await writeFile(path.join(target, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const e of entries)
    await copyFile(path.join(source, `${e.tag}.sql`), path.join(target, `${e.tag}.sql`));
  return target;
}

/**
 * Integration tests run against a real MySQL 8 (spec 19.1). Two modes:
 *  - TEST_DATABASE_URL set (CI service container or a local server): a fresh database per test file is created
 *    on that server and dropped afterwards.
 *  - otherwise Testcontainers starts mysql:8.0 (requires Docker).
 */
export async function createTestDatabase(opts: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const base = process.env['TEST_DATABASE_URL'] ?? (await startContainer());
  const name = `oremedia_test_${randomBytes(6).toString('hex')}`;
  const admin = await mysql.createConnection(base);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await admin.end();
  const u = new URL(base);
  u.pathname = `/${name}`;
  const url = u.toString();
  await runMigrations(
    url,
    opts.migrationsUpTo ? { migrationsFolder: await migrationsUpTo(opts.migrationsUpTo) } : {},
  );
  const tdb: TestDatabase = {
    db: configureDatabase({ url, connectionLimit: 4 }),
    url,
    name,
    adminUrl: base,
    async migrateToHead() {
      await runMigrations(url);
      tdb.db = configureDatabase({ url, connectionLimit: 4 });
      return tdb.db;
    },
    async drop() {
      await closeDatabase();
      const c = await mysql.createConnection(base);
      await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await c.end();
    },
  };
  return tdb;
}

let containerUrl: string | null = null;
async function startContainer(): Promise<string> {
  if (containerUrl) return containerUrl;
  const { MySqlContainer } = await import('@testcontainers/mysql');
  const c = await new MySqlContainer('mysql:8.0').withRootPassword('test').start();
  containerUrl = `mysql://root:test@${c.getHost()}:${c.getPort()}/mysql`;
  return containerUrl;
}

/**
 * A MySQL user on this test database with a generated role's grants (roles/app-role.sql or retention-role.sql),
 * for tests that prove what the engine allows each role. Returns the user's connection URL; drop() removes it.
 */
export async function createRoleUser(
  tdb: Pick<TestDatabase, 'adminUrl' | 'name'>,
  role: 'app' | 'retention',
): Promise<{ url: string; user: string; drop(): Promise<void> }> {
  const user = `oremedia_${role === 'app' ? 'app' : 'ret'}_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('hex');
  const sql = (role === 'app' ? generateRoleSql : generateRetentionRoleSql)(tdb.name, user, '%').replace(
    `CREATE USER IF NOT EXISTS '${user}'@'%';`,
    `CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED WITH mysql_native_password BY '${password}';`,
  );
  const admin = await mysql.createConnection(tdb.adminUrl);
  for (const stmt of sql.split('\n').filter((l) => l && !l.startsWith('--'))) await admin.query(stmt);
  await admin.end();
  const u = new URL(tdb.adminUrl);
  u.username = user;
  u.password = password;
  u.pathname = `/${tdb.name}`;
  return {
    url: u.toString(),
    user,
    async drop() {
      const c = await mysql.createConnection(tdb.adminUrl);
      await c.query(`DROP USER IF EXISTS '${user}'@'%'`);
      await c.end();
    },
  };
}
