import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { createRoleUser, createTestDatabase, type TestDatabase } from './testing';
import { generateRetentionRoleSql } from './roles';
import { INSERT_ONLY_TABLES, RETENTION_ROLE_GRANTS } from './global-tables';

/**
 * Ledger 7.16 (spec 17.5, 6.1): the retention role (roles/retention-role.sql) may DELETE exactly the insert-only
 * tables the retention sweep's TTL classes remove, and nothing else insert-only. Checked by the engine, with the
 * generated grant SQL applied to a real user (createRoleUser, both database modes). The application role's refusal
 * is immutability.integration.test.ts; the sweep running on this role end to end is worker-core's
 * retention-role.integration.test.ts.
 */
const DENIED = { code: 'ER_TABLEACCESS_DENIED_ERROR' };

describe('retention database role', () => {
  let tdb: TestDatabase;
  let role: Awaited<ReturnType<typeof createRoleUser>>;
  let retention: mysql.Connection;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    role = await createRoleUser(tdb, 'retention');
    retention = await mysql.createConnection(role.url);
    const admin = await mysql.createConnection(tdb.url);
    await admin.query(
      `INSERT INTO audit_events (id, tenant_id, actor_kind, actor_id, action, resource_type, resource_id, decision, correlation_id, created_at) VALUES ('aud_r1', 'ten_1', 'user', 'usr_1', 'x', 't', 'r', 'allowed', 'c', NOW(3))`,
    );
    await admin.end();
  });
  afterAll(async () => {
    await retention?.end();
    await role?.drop();
    await tdb?.drop();
  });

  it('the grant list deletes only insert-only tables a TTL class removes, and never evidence', () => {
    const deletable = Object.entries(RETENTION_ROLE_GRANTS)
      .filter(([, p]) => p.includes('DELETE'))
      .map(([t]) => t);
    expect(deletable.filter((t) => INSERT_ONLY_TABLES.includes(t)).sort()).toEqual([
      'agent_steps',
      'link_clicks',
      'metric_snapshots',
      'tool_invocations',
    ]);
    for (const evidence of ['audit_events', 'creative_revisions', 'rendered_exports', 'usage_ledger'])
      expect(deletable).not.toContain(evidence);
    expect(() => generateRetentionRoleSql('db', 'u')).not.toThrow();
  });

  it('the retention role deletes what the sweep removes and nothing else', async () => {
    for (const t of ['agent_steps', 'tool_invocations', 'metric_snapshots', 'link_clicks', 'messages'])
      await retention.query(`DELETE FROM \`${t}\` WHERE created_at < NOW(3) - INTERVAL 90 DAY`);
    await retention.query(
      `INSERT INTO audit_events (id, tenant_id, actor_kind, actor_id, action, resource_type, resource_id, decision, correlation_id, created_at) VALUES ('aud_r2', 'ten_1', 'platform_operator', 'retention-sweep', 'retention.apply', 'retention_class', 'metrics', 'allowed', 'c', NOW(3))`,
    );
    // Evidence and everything outside the sweep stay out of reach.
    await expect(retention.query(`DELETE FROM audit_events WHERE id = 'aud_r1'`)).rejects.toMatchObject(
      DENIED,
    );
    await expect(retention.query(`UPDATE audit_events SET action = 'y'`)).rejects.toMatchObject(DENIED);
    for (const t of [
      'creative_revisions',
      'rendered_exports',
      'render_previews',
      'preview_exports',
      'usage_ledger',
      'agent_runs',
      'tenants',
    ])
      await expect(retention.query(`DELETE FROM \`${t}\` WHERE 1 = 0`), t).rejects.toMatchObject(DENIED);
    await expect(retention.query(`UPDATE agent_steps SET summary = 'x' WHERE 1 = 0`)).rejects.toMatchObject(
      DENIED,
    );
    await expect(retention.query(`SELECT id FROM tenants`)).rejects.toMatchObject(DENIED);
    await expect(retention.query(`DROP TABLE agent_steps`)).rejects.toMatchObject(DENIED);
  });
});
