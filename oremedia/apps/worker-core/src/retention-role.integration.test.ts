import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createRetentionActivities } from '@oremedia/activities';
import { configureDatabase, configureRoleDatabase, type Db } from '@oremedia/db';
import { tenants, users } from '@oremedia/db/schema/access';
import { agentRuns, agentSteps } from '@oremedia/db/schema/agents';
import { brands } from '@oremedia/db/schema/brand';
import { auditEvents } from '@oremedia/db/schema/operations';
import { createRoleUser, createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createOperationsRuntime } from '@oremedia/module-operations';
import { runRetentionSweep } from '@oremedia/workflows/retention-sweep.workflow.v1';
import { composeModules } from './composition';
import { operationsActivities } from './operations-worker';

/**
 * Ledger 7.16 end to end: worker-core's database connection is the application role (roles/app-role.sql) and the
 * retention connection (DATABASE_URL_RETENTION) is the retention role (roles/retention-role.sql). The sweep's
 * activities as worker-core registers them (operationsActivities) remove agent transcripts past their TTL on the
 * retention connection and audit it; the same activities without the retention connection are refused by the
 * engine, so the separate role is what makes the TTL work while the application role keeps no DELETE on evidence.
 */
const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

// createRoleUser applies the generated grants on whichever server createTestDatabase used (both modes).
describe('retention sweep on the retention role (ledger 7.16)', () => {
  let tdb: TestDatabase;
  let appDb: Db;
  const roles: Array<{ drop(): Promise<void> }> = [];
  let retentionUrl = '';
  const tenantId = newId('ten');
  const brandId = newId('brd');
  const runId = newId('run');
  const oldStep = newId('step');
  const newStep = newId('step');
  const old = new Date(Date.now() - 200 * 86_400_000); // past the 90-day agent transcript TTL
  const input = { correlationId: 'corr_retention_role', now: new Date().toISOString(), dryRun: false };

  const stepIds = async () =>
    (
      await appDb
        .select({ id: agentSteps.id })
        .from(agentSteps)
        .where(eq(agentSteps.tenantId, tenantId))
        .orderBy(asc(agentSteps.id))
    ).map((r) => r.id);
  const retentionAudits = async () =>
    (
      await appDb
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.action, 'retention.apply')))
    ).length;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    const ownerId = newId('usr');
    await tdb.db
      .insert(tenants)
      .values({ id: tenantId, name: 'R', slug: `rr-${tenantId.slice(-10).toLowerCase()}` });
    await tdb.db.insert(users).values({ id: ownerId, email: `${ownerId}@example.test`, name: 'Owner' });
    await tdb.db.insert(brands).values({
      id: brandId,
      tenantId,
      name: 'R brand',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await tdb.db.insert(agentRuns).values({
      id: runId,
      tenantId,
      brandId,
      initiatorKind: 'user',
      initiatorId: ownerId,
      servicePrincipalId: newId('sp'),
      autonomyMode: 'create',
      taskKind: 'copywriting',
      brief: {},
      skillVersionIds: [],
      modelConfig: {},
      state: 'completed',
      deadlineAt: new Date(),
      correlationId: 'corr_retention_role',
    });
    await tdb.db.insert(agentSteps).values([
      { id: oldStep, tenantId, runId, index: 0, kind: 'model_call', summary: 'old', createdAt: old },
      { id: newStep, tenantId, runId, index: 1, kind: 'model_call', summary: 'new' },
    ]);
    const app = await createRoleUser(tdb, 'app');
    const retention = await createRoleUser(tdb, 'retention');
    roles.push(app, retention);
    retentionUrl = retention.url;
    composeModules(); // registers the retention handlers and the tenant source, as worker-core does
    // worker.ts: DATABASE_URL is the application role, DATABASE_URL_RETENTION the retention role.
    appDb = configureDatabase({ url: app.url, connectionLimit: 2 });
  });
  afterAll(async () => {
    for (const r of roles) await r.drop();
    await tdb?.drop();
  });

  it('control: on the application role the TTL delete is refused by the engine and nothing is removed', async () => {
    const onAppRole = createRetentionActivities(createOperationsRuntime().retention);
    expect(await runRetentionSweep(onAppRole, input)).toMatchObject({ tenants: 0, failed: 1, rows: 0 });
    expect(await stepIds()).toEqual([oldStep, newStep].sort());
    expect(await retentionAudits()).toBe(0);
  });

  it('worker-core runs the sweep on the retention connection: rows past their TTL go, the rest stays, it is audited', async () => {
    configureRoleDatabase('retention', { url: retentionUrl, connectionLimit: 2 });
    expect(await runRetentionSweep(operationsActivities(), input)).toMatchObject({
      tenants: 1,
      failed: 0,
      rows: 1,
    });
    expect(await stepIds()).toEqual([newStep]);
    expect(await retentionAudits()).toBe(1); // written through the retention role's INSERT on audit_events
  });
});
