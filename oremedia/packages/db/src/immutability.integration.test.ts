import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { createRoleUser, createTestDatabase, type TestDatabase } from './testing';
import { INSERT_ONLY_TABLES } from './global-tables';

const DENIED = { code: 'ER_TABLEACCESS_DENIED_ERROR' };

/**
 * Spec 6.1: insert-only tables are enforced by a DB role without UPDATE/DELETE where the engine permits. The
 * generated application role (roles/app-role.sql) is applied to a real user (createRoleUser: works on
 * TEST_DATABASE_URL and on the Testcontainers server alike) and the engine is asked.
 */
describe('insert-only enforcement by database role', () => {
  let tdb: TestDatabase;
  let role: Awaited<ReturnType<typeof createRoleUser>>;
  let app: mysql.Connection;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    role = await createRoleUser(tdb, 'app');
    app = await mysql.createConnection(role.url);
  });
  afterAll(async () => {
    await app?.end();
    await role?.drop();
    await tdb?.drop();
  });

  it('the app role can insert and select audit events but cannot update or delete them', async () => {
    expect(INSERT_ONLY_TABLES).toContain('audit_events');
    await app.query(
      `INSERT INTO audit_events (id, tenant_id, actor_kind, actor_id, action, resource_type, resource_id, decision, correlation_id, created_at) VALUES ('aud_1', 'ten_1', 'user', 'usr_1', 'x', 't', 'r', 'allowed', 'c', NOW(3))`,
    );
    const [rows] = await app.query('SELECT id FROM audit_events');
    expect((rows as unknown[]).length).toBe(1);
    await expect(app.query(`UPDATE audit_events SET action = 'y' WHERE id = 'aud_1'`)).rejects.toMatchObject(
      DENIED,
    );
    await expect(app.query(`DELETE FROM audit_events WHERE id = 'aud_1'`)).rejects.toMatchObject(DENIED);
  });

  it('the preview tables are insert-only like rendered_exports: no UPDATE or DELETE for the app role', async () => {
    // Named explicitly (not only through INSERT_ONLY_TABLES) so dropping one from the list fails here.
    for (const t of ['render_previews', 'preview_exports', 'rendered_exports']) {
      await expect(app.query(`SELECT id FROM \`${t}\` WHERE 1 = 0`)).resolves.toBeDefined();
      await expect(app.query(`UPDATE \`${t}\` SET id = id WHERE 1 = 0`), t).rejects.toMatchObject(DENIED);
      await expect(app.query(`DELETE FROM \`${t}\` WHERE 1 = 0`), t).rejects.toMatchObject(DENIED);
    }
  });

  it('every insert-only table refuses UPDATE and DELETE to the app role', async () => {
    for (const t of INSERT_ONLY_TABLES) {
      await expect(app.query(`UPDATE \`${t}\` SET id = id WHERE 1 = 0`), t).rejects.toMatchObject(DENIED);
      await expect(app.query(`DELETE FROM \`${t}\` WHERE 1 = 0`), t).rejects.toMatchObject(DENIED);
    }
  });

  it('the app role keeps full DML on mutable tables', async () => {
    await app.query(
      `INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('ten_x', 'X', 'x-slug', NOW(3), NOW(3))`,
    );
    await app.query(`UPDATE tenants SET name = 'Y' WHERE id = 'ten_x'`);
    await app.query(`DELETE FROM tenants WHERE id = 'ten_x'`);
  });
});
