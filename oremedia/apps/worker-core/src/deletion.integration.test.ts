import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { getTableConfig, type MySqlColumn, type MySqlTable } from 'drizzle-orm/mysql-core';
import {
  purgeOrder,
  runInTenant,
  tenantScopedTables,
  withTransaction,
  type TenantContext,
} from '@oremedia/db';
import { tenants, users } from '@oremedia/db/schema/access';
import { agentRuns, agentSteps } from '@oremedia/db/schema/agents';
import { assetDerivatives, assetVersions, uploadIntents } from '@oremedia/db/schema/assets';
import { renderedExports } from '@oremedia/db/schema/creative';
import { messages } from '@oremedia/db/schema/community';
import { metricSnapshots } from '@oremedia/db/schema/measurement';
import { auditEvents, deletionRequests, outboxEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { createDeletionActivities, createRetentionActivities } from '@oremedia/activities';
import { MemoryStorageProvider, configureStorage } from '@oremedia/module-assets';
import {
  createOperationsRuntime,
  deletion,
  deletionHandlers,
  outboxRouteFor,
} from '@oremedia/module-operations';
import type { DeletionWorkflowInputV1 } from '@oremedia/contracts/operations';
import { runDeletionRequest } from '@oremedia/workflows/deletion-request.workflow.v1';
import { runRetentionSweep } from '@oremedia/workflows/retention-sweep.workflow.v1';
import { callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';
import { composeModules } from './composition';
import { RETAINED_ON_DELETION, deletionCoverage } from './deletion-handlers';

/**
 * Spec 17.5 / ledger 7.16 end to end against MySQL through the worker-core composition root: two tenants seeded
 * like the cross-tenant harness, plus one generic row in every tenant-scoped table the seed leaves empty, so every
 * table in the schema holds rows of both tenants. Tenant A's owner requests deletion of tenant A through the API;
 * the outbox route starts deletionRequestWorkflowV1 (fake Temporal host, real activities and handlers); afterwards
 * every tenant-scoped table holds no row of A except the retained evidence (audit, release evidence, the request),
 * A's users are anonymised, its objects and credentials gone, tenant B is byte-for-byte untouched, and a second
 * run changes nothing. A brand deletion narrows to one brand; the retention sweep counts in a dry run and removes
 * only rows past their TTL.
 */
const ULID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const rid = (prefix: string) =>
  `${prefix}_${Array.from({ length: 26 }, () => ULID[Math.floor(Math.random() * 32)]).join('')}`;

type Counts = Record<string, number>;
const countsOf = async (t: SeededTenant): Promise<Counts> =>
  (JSON.parse(await t.snapshot()) as { counts: Counts }).counts;

/**
 * A minimal valid row for any tenant-scoped table: required columns filled by type, tenant and brand set, and
 * every foreign key pointed at an existing parent row of the same tenant (parents are filled first).
 */
async function fillEmptyTables(tdb: TestDatabase, t: SeededTenant): Promise<string[]> {
  const filled: string[] = [];
  const tables = purgeOrder(tenantScopedTables()).reverse(); // parents before children
  for (const table of tables) {
    const name = getTableName(table);
    const cols = Object.values(getTableColumns(table)) as MySqlColumn[];
    const tenantCol = cols.find((c) => c.name === 'tenant_id')!;
    const [{ n } = { n: 0 }] = await tdb.db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .where(eq(tenantCol, t.tenantId));
    if (Number(n) > 0) continue;
    const row: Record<string, unknown> = {};
    for (const c of cols) {
      const key = Object.entries(getTableColumns(table)).find(([, v]) => v === c)![0];
      if (c.name === 'tenant_id') row[key] = t.tenantId;
      else if (c.name === 'brand_id') row[key] = t.brandIds[0];
      else if (c.name === 'id') row[key] = rid(name.slice(0, 3));
      else if (!c.notNull || c.hasDefault) continue;
      else {
        const values = (c as unknown as { enumValues?: string[] }).enumValues;
        if (values?.length) row[key] = values[0];
        else if (c.dataType === 'number' || c.dataType === 'bigint') row[key] = 0;
        else if (c.dataType === 'boolean') row[key] = false;
        else if (c.dataType === 'date') row[key] = new Date();
        else if (c.dataType === 'json') row[key] = {};
        else row[key] = `x${Math.random().toString(36).slice(2, 10)}`;
      }
    }
    for (const fk of getTableConfig(table).foreignKeys) {
      const ref = fk.reference();
      const parent = ref.foreignTable as MySqlTable;
      const parentCols = Object.values(getTableColumns(parent)) as MySqlColumn[];
      const parentTenant = parentCols.find((c) => c.name === 'tenant_id');
      const parentBrand = parentCols.find((c) => c.name === 'brand_id');
      // The parent in the same tenant and, where the key carries the brand, the same brand (brand 1).
      const brandAt = ref.columns.findIndex((c) => c.name === 'brand_id');
      const brandKey = brandAt >= 0 ? ref.foreignColumns[brandAt] : parentBrand;
      const where = [
        parentTenant
          ? eq(parentTenant, t.tenantId)
          : eq(
              parentCols.find((c) => c.name === 'id')!,
              t.tenantId,
            ),
        ...(brandKey ? [eq(brandKey, t.brandIds[0])] : []),
      ];
      const [p] = await tdb.db
        .select()
        .from(parent)
        .where(and(...where))
        .limit(1);
      if (!p) throw new Error(`no ${getTableName(parent)} row of the tenant for ${name}`);
      ref.columns.forEach((c, i) => {
        const key = Object.entries(getTableColumns(table)).find(([, v]) => v === c)![0];
        const pKey = Object.entries(getTableColumns(parent)).find(([, v]) => v === ref.foreignColumns[i])![0];
        row[key] = (p as Record<string, unknown>)[pKey];
      });
    }
    await tdb.db.insert(table).values(row as never);
    filled.push(name);
  }
  return filled;
}

describe('deletion and retention fan-out end to end (spec 17.5, ledger 7.16)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const mem = new MemoryStorageProvider();
  const runtime = createOperationsRuntime();
  const acts = createDeletionActivities(runtime.deletion);
  let beforeB: Counts;
  let keysA: string[] = [];
  let keysB: string[] = [];
  let requestId = '';
  let input: DeletionWorkflowInputV1;

  const ctx = (t: SeededTenant): TenantContext => ({
    tenantId: t.tenantId,
    actor: { kind: 'user', id: t.ownerUserId },
    brandIds: 'all',
    correlationId: 'corr_deletion',
  });
  const keysOf = async (t: SeededTenant) => {
    const out: string[] = [];
    for (const [table, col] of [
      [assetVersions, assetVersions.storageKey],
      [assetDerivatives, assetDerivatives.storageKey],
      [uploadIntents, uploadIntents.storageKey],
      [renderedExports, renderedExports.storageKey],
    ] as const)
      for (const r of await tdb.db.select({ k: col }).from(table).where(eq(table.tenantId, t.tenantId)))
        out.push(r.k);
    return out;
  };

  beforeAll(async () => {
    tdb = await createTestDatabase();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    composeModules(); // the worker's composition root: routes and every deletion / retention handler
    configureStorage(mem);
    for (const t of [tenantA, tenantB]) await fillEmptyTables(tdb, t);
    // Storage keys of the generic rows are not tenant-prefixed; give A's and B's export rows real keys and objects.
    for (const t of [tenantA, tenantB]) {
      await tdb.db
        .update(renderedExports)
        .set({
          storageKey: sql`concat('assets/', ${renderedExports.tenantId}, '/', ${renderedExports.brandId}, '/exports/', ${renderedExports.id}, '.png')`,
        })
        .where(eq(renderedExports.tenantId, t.tenantId));
      await tdb.db
        .update(uploadIntents)
        .set({ storageKey: sql`concat('quarantine/', ${uploadIntents.tenantId}, '/', ${uploadIntents.id})` })
        .where(eq(uploadIntents.tenantId, t.tenantId));
      for (const k of await keysOf(t))
        await runInTenant(ctx(t), () => mem.putObject(k, Buffer.from(k), { contentType: 'image/png' }));
    }
    keysA = await keysOf(tenantA);
    keysB = await keysOf(tenantB);
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('every tenant-scoped table is owned by exactly one deletion handler, and every one holds rows of both tenants', async () => {
    expect(deletionCoverage()).toEqual({ uncovered: [], duplicated: [] });
    const a = await countsOf(tenantA);
    const b = await countsOf(tenantB);
    const allTables = tenantScopedTables().map((t) => getTableName(t));
    for (const [label, counts] of [
      ['A', a],
      ['B', b],
    ] as const) {
      const empty = allTables.filter(
        (n) => (counts[n] ?? 0) === 0 && n !== 'audit_events' && n !== 'deletion_requests',
      );
      expect(empty, `tenant ${label} has no rows in`).toEqual([]);
    }
    expect(keysA.length).toBeGreaterThanOrEqual(4);
    expect(keysA.every((k) => mem.has(k))).toBe(true);
  });

  it("a request naming another tenant is NOT_FOUND; the owner's tenant request routes deletionRequestWorkflowV1 on core", async () => {
    const foreign = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'operations.deletion.request',
      { subjectType: 'tenant', subjectId: tenantB.tenantId, reason: 'not mine' },
    );
    expect(foreign.error?.code).toBe('NOT_FOUND');
    const res = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'operations.deletion.request',
      { subjectType: 'tenant', subjectId: tenantA.tenantId, reason: 'contract ended' },
    );
    expect(res.error).toBeUndefined();
    requestId = (res.data as { deletionRequestId: string }).deletionRequestId;
    const [evt] = await tdb.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.tenantId, tenantA.tenantId),
          eq(outboxEvents.eventType, 'operations.deletion_requested'),
        ),
      );
    const req = outboxRouteFor(evt!.eventType)!({ ...evt!, payload: evt!.payload })!;
    expect(req).toMatchObject({
      workflowType: 'deletionRequestWorkflowV1',
      taskQueue: 'core',
      workflowId: `deletion:${requestId}`,
    });
    input = req.args[0] as DeletionWorkflowInputV1;
    expect(input).toMatchObject({
      tenantId: tenantA.tenantId,
      actor: { kind: 'user', id: tenantA.ownerUserId },
      deletionRequestId: requestId,
    });
    beforeB = await countsOf(tenantB);
  });

  it("the fan-out removes every row of tenant A except the retained evidence, anonymises A's users, deletes A's objects and leaves B untouched", async () => {
    const snapshotB = await tenantB.snapshot();
    const out = await runDeletionRequest(acts, input);
    expect(out.state).toBe('blocked'); // waiting for the operator-only stores
    expect(out.operatorActions).toEqual(['temporal_visibility', 'logs', 'backups', 'provider_side']);
    expect(out.steps.map((s) => s.handler)).toEqual(deletionHandlers().map((h) => h.name));
    expect(out.steps.filter((s) => s.status === 'done').map((s) => s.handler)).toEqual(
      expect.arrayContaining(['credentials', 'objects', 'publishing', 'assets', 'access', 'operations']),
    );

    const after = await countsOf(tenantA);
    const left = Object.entries(after)
      .filter(([, n]) => n > 0)
      .map(([k]) => k)
      .sort();
    expect(left).toEqual(Object.keys(RETAINED_ON_DELETION).sort());
    expect(after['remote_evidence']).toBeGreaterThan(0); // release evidence retained (spec 17.5, 7 years)
    expect(after['audit_events']).toBeGreaterThan(0);

    // Identity: A's users are pseudonymous rows now; the tenant row is a tombstone; sessions revoked.
    for (const userId of [tenantA.ownerUserId, tenantA.creatorUserId]) {
      const [u] = await tdb.db.select().from(users).where(eq(users.id, userId));
      expect(u).toMatchObject({ status: 'deleted', name: 'Deleted user', passwordHash: null });
      expect(u!.email).toBe(`deleted+${userId.toLowerCase()}@deleted.invalid`);
    }
    const [t] = await tdb.db.select().from(tenants).where(eq(tenants.id, tenantA.tenantId));
    expect(t).toMatchObject({ name: 'Deleted tenant', status: 'closing' });
    const [ub] = await tdb.db.select().from(users).where(eq(users.id, tenantB.ownerUserId));
    expect(ub!.status).toBe('active');

    // Object storage: every key A's rows named is gone; B's are all there.
    expect(keysA.filter((k) => mem.has(k))).toEqual([]);
    expect(keysB.every((k) => mem.has(k))).toBe(true);

    // Tenant B: every row, membership, principal and client exactly as before.
    expect(await tenantB.snapshot()).toBe(snapshotB);
    expect(await countsOf(tenantB)).toEqual(beforeB);

    // Evidence on the request: fan-out status per handler and store, one audited step per handler with counts.
    const [row] = await tdb.db.select().from(deletionRequests).where(eq(deletionRequests.id, requestId));
    expect(row).toMatchObject({ state: 'blocked', subjectType: 'tenant' });
    expect(row!.blockedReason).toContain('temporal_visibility');
    expect(row!.fanout).toMatchObject({
      database: 'done',
      object_storage: 'done',
      indexes: 'done',
      temporal_visibility: 'blocked',
      logs: 'blocked',
      backups: 'blocked',
      provider_side: 'blocked',
      credentials: 'done',
      publishing: 'done',
    });
    const steps = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.resourceId, requestId), eq(auditEvents.action, 'deletion.step')));
    expect(steps).toHaveLength(deletionHandlers().length);
    const publishingStep = steps.find((s) => s.metadata?.['scope'] === 'publishing')!;
    expect(String(publishingStep.metadata?.['evidence'])).toMatch(/publications=1/);
    const credentialStep = steps.find((s) => s.metadata?.['scope'] === 'credentials')!;
    expect(String(credentialStep.metadata?.['evidence'])).toMatch(/credentials_shredded=[1-9]/);
  });

  it('a second run is a no-op (nothing pending, no row written anywhere), and the operator confirmations complete it', async () => {
    const auditBefore = (await countsOf(tenantA))['audit_events'];
    const [before] = await tdb.db.select().from(deletionRequests).where(eq(deletionRequests.id, requestId));
    const again = await runDeletionRequest(acts, input);
    expect(again).toEqual({ state: 'blocked', steps: [], operatorActions: again.operatorActions });
    const [after] = await tdb.db.select().from(deletionRequests).where(eq(deletionRequests.id, requestId));
    expect(after!.version).toBe(before!.version);
    expect((await countsOf(tenantA))['audit_events']).toBe(auditBefore);
    expect(await countsOf(tenantB)).toEqual(beforeB);

    for (const step of again.operatorActions)
      await runInTenant(ctx(tenantA), () =>
        withTransaction((tx) =>
          deletion.confirmOperatorAction(
            { kind: 'platform_operator', id: 'oncall' },
            requestId,
            step,
            `${step} purged per runbook`,
            tx,
          ),
        ),
      );
    const [done] = await tdb.db.select().from(deletionRequests).where(eq(deletionRequests.id, requestId));
    expect(done).toMatchObject({ state: 'completed' });
    expect(done!.completedAt).not.toBeNull();
    expect(done!.fanout).toMatchObject({ temporal_visibility: 'done', logs: 'done', backups: 'done' });
  });

  it("a brand deletion removes only that brand's rows (and the brand); the tenant's other brand and tenant-level rows stay", async () => {
    const brand = tenantB.brandIds[0];
    const other = tenantB.brandIds[1];
    const brandRows = async (brandId: string) => {
      let n = 0;
      for (const table of tenantScopedTables()) {
        const b = (Object.values(getTableColumns(table)) as MySqlColumn[]).find((c) => c.name === 'brand_id');
        if (!b) continue;
        const [r] = await tdb.db
          .select({ n: sql<number>`count(*)` })
          .from(table)
          .where(eq(b, brandId));
        n += Number(r?.n ?? 0);
      }
      return n;
    };
    expect(await brandRows(brand)).toBeGreaterThan(20);
    const otherBefore = await brandRows(other);
    const res = await callPath(
      { bearer: tenantB.ownerToken, tenantId: tenantB.tenantId },
      'operations.deletion.request',
      { subjectType: 'brand', subjectId: brand, reason: 'brand retired' },
    );
    const id = (res.data as { deletionRequestId: string }).deletionRequestId;
    const out = await runDeletionRequest(acts, {
      tenantId: tenantB.tenantId,
      actor: { kind: 'user', id: tenantB.ownerUserId },
      correlationId: 'corr_brand_deletion',
      deletionRequestId: id,
    });
    expect(out.state).toBe('blocked');
    // brand_id rows of the brand are gone except the retained evidence tables.
    let remaining = 0;
    for (const table of tenantScopedTables()) {
      const name = getTableName(table);
      const b = (Object.values(getTableColumns(table)) as MySqlColumn[]).find((c) => c.name === 'brand_id');
      if (!b || RETAINED_ON_DELETION[name]) continue;
      const [r] = await tdb.db
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .where(eq(b, brand));
      if (Number(r?.n ?? 0) > 0) remaining += 1;
    }
    expect(remaining).toBe(0);
    expect(await brandRows(other)).toBe(otherBefore);
    // Children without brand_id followed their brand-owned parent (agent steps of the brand's runs).
    expect(await tdb.db.select().from(agentRuns).where(eq(agentRuns.brandId, brand))).toHaveLength(0);
    // Tenant-level rows stay: memberships, the tenant's owner, service principals.
    const counts = await countsOf(tenantB);
    expect(counts['memberships']).toBe(2);
    expect(counts['service_principals']).toBe(1);
    const [ub] = await tdb.db.select().from(users).where(eq(users.id, tenantB.ownerUserId));
    expect(ub!.status).toBe('active');
  });

  it('the retention sweep counts in a dry run, then removes only rows past their TTL (agent transcripts, metrics, raw voice)', async () => {
    const t = tenantB;
    const brand = t.brandIds[1];
    const old = new Date(Date.now() - 800 * 86_400_000); // past every default TTL
    const runId = rid('run');
    await tdb.db.insert(agentRuns).values({
      id: runId,
      tenantId: t.tenantId,
      brandId: brand,
      initiatorKind: 'user',
      initiatorId: t.ownerUserId,
      servicePrincipalId: t.servicePrincipalId,
      autonomyMode: 'create',
      taskKind: 'draft_generation',
      brief: {},
      skillVersionIds: [],
      modelConfig: {},
      state: 'completed',
      deadlineAt: new Date(),
      correlationId: 'corr_retention',
    });
    const oldStep = rid('stp');
    const newStep = rid('stp');
    await tdb.db.insert(agentSteps).values([
      {
        id: oldStep,
        tenantId: t.tenantId,
        runId,
        index: 0,
        kind: 'model_call',
        summary: 'old',
        createdAt: old,
      },
      { id: newStep, tenantId: t.tenantId, runId, index: 1, kind: 'model_call', summary: 'new' },
    ]);
    const acts = createRetentionActivities(runtime.retention);
    const input = { correlationId: 'corr_retention', now: new Date().toISOString() };
    const dry = await runRetentionSweep(acts, { ...input, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.rows).toBeGreaterThanOrEqual(1);
    expect(await tdb.db.select().from(agentSteps).where(eq(agentSteps.id, oldStep))).toHaveLength(1);

    const applied = await runRetentionSweep(acts, { ...input, dryRun: false });
    expect(applied.rows).toBe(dry.rows);
    expect(await tdb.db.select().from(agentSteps).where(eq(agentSteps.id, oldStep))).toHaveLength(0);
    expect(await tdb.db.select().from(agentSteps).where(eq(agentSteps.id, newStep))).toHaveLength(1);
    expect(await tdb.db.select().from(agentRuns).where(eq(agentRuns.id, runId))).toHaveLength(1); // summary kept
    const audited = await tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, t.tenantId), eq(auditEvents.action, 'retention.apply')));
    expect(audited.length).toBeGreaterThanOrEqual(1);
    // A second pass finds nothing past its TTL.
    expect((await runRetentionSweep(acts, { ...input, dryRun: false })).rows).toBe(0);
    // Metrics and raw messages of the other tenant's live brand stay (none are older than their TTL).
    expect(
      (await tdb.db.select().from(metricSnapshots).where(eq(metricSnapshots.tenantId, t.tenantId))).length,
    ).toBe((await countsOf(t))['metric_snapshots']);
    expect(await tdb.db.select().from(messages).where(eq(messages.tenantId, tenantA.tenantId))).toHaveLength(
      0,
    );
  });
});
