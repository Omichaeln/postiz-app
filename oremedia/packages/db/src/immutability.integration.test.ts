import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { createTestDatabase, type TestDatabase } from './testing';
import { generateRoleSql } from './roles';
import { INSERT_ONLY_TABLES } from './global-tables';

/** Spec 6.1: insert-only tables are enforced by a DB role without UPDATE/DELETE where the engine permits. */
describe('insert-only enforcement by database role', () => {
  let tdb: TestDatabase;
  let app: mysql.Connection;
  const user = `oremedia_app_${Date.now().toString(36)}`;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const base = process.env['TEST_DATABASE_URL'];
    if (!base) return;
    const admin = await mysql.createConnection(base);
    const sql = generateRoleSql(tdb.name, user, '%').replace(
      `CREATE USER IF NOT EXISTS '${user}'@'%';`,
      `CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED WITH mysql_native_password BY 'app-pass';`,
    );
    for (const stmt of sql.split('\n').filter((l) => l && !l.startsWith('--'))) await admin.query(stmt);
    await admin.end();
    const u = new URL(base);
    app = await mysql.createConnection({
      host: u.hostname,
      port: Number(u.port || 3306),
      user,
      password: 'app-pass',
      database: tdb.name,
    });
  });
  afterAll(async () => {
    await app?.end();
    if (process.env['TEST_DATABASE_URL']) {
      const admin = await mysql.createConnection(process.env['TEST_DATABASE_URL']);
      await admin.query(`DROP USER IF EXISTS '${user}'@'%'`);
      await admin.end();
    }
    await tdb?.drop();
  });

  it.skipIf(!process.env['TEST_DATABASE_URL'])(
    'the app role can insert and select audit events but cannot update or delete them',
    async () => {
      expect(INSERT_ONLY_TABLES).toContain('audit_events');
      await app.query(
        `INSERT INTO audit_events (id, tenant_id, actor_kind, actor_id, action, resource_type, resource_id, decision, correlation_id, created_at) VALUES ('aud_1', 'ten_1', 'user', 'usr_1', 'x', 't', 'r', 'allowed', 'c', NOW(3))`,
      );
      const [rows] = await app.query('SELECT id FROM audit_events');
      expect((rows as unknown[]).length).toBe(1);
      await expect(
        app.query(`UPDATE audit_events SET action = 'y' WHERE id = 'aud_1'`),
      ).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR' });
      await expect(app.query(`DELETE FROM audit_events WHERE id = 'aud_1'`)).rejects.toMatchObject({
        code: 'ER_TABLEACCESS_DENIED_ERROR',
      });
    },
  );

  it.skipIf(!process.env['TEST_DATABASE_URL'])('the app role keeps full DML on mutable tables', async () => {
    await app.query(
      `INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('ten_x', 'X', 'x-slug', NOW(3), NOW(3))`,
    );
    await app.query(`UPDATE tenants SET name = 'Y' WHERE id = 'ten_x'`);
    await app.query(`DELETE FROM tenants WHERE id = 'ten_x'`);
  });
});
