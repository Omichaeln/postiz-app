import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { closeDatabase, configureDatabase, type Db } from '../client';
import { runMigrations } from '../migrate';

export interface TestDatabase {
  db: Db;
  url: string;
  name: string;
  drop(): Promise<void>;
}

/**
 * Integration tests run against a real MySQL 8 (spec 19.1). Two modes:
 *  - TEST_DATABASE_URL set (CI service container or a local server): a fresh database per test file is created
 *    on that server and dropped afterwards.
 *  - otherwise Testcontainers starts mysql:8.0 (requires Docker).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const base = process.env['TEST_DATABASE_URL'] ?? (await startContainer());
  const name = `oremedia_test_${randomBytes(6).toString('hex')}`;
  const admin = await mysql.createConnection(base);
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await admin.end();
  const u = new URL(base);
  u.pathname = `/${name}`;
  const url = u.toString();
  await runMigrations(url);
  const db = configureDatabase({ url, connectionLimit: 4 });
  return {
    db,
    url,
    name,
    async drop() {
      await closeDatabase();
      const c = await mysql.createConnection(base);
      await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
      await c.end();
    },
  };
}

let containerUrl: string | null = null;
async function startContainer(): Promise<string> {
  if (containerUrl) return containerUrl;
  const { MySqlContainer } = await import('@testcontainers/mysql');
  const c = await new MySqlContainer('mysql:8.0').withRootPassword('test').start();
  containerUrl = `mysql://root:test@${c.getHost()}:${c.getPort()}/mysql`;
  return containerUrl;
}
