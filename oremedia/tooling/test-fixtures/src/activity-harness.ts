import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, getTableColumns, getTableName } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import { isOremediaError } from '@oremedia/contracts/errors';
import type { Db } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { deletionRequests } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { newId } from '@oremedia/domain/ids';
import { seedTwoTenants, type SeededTenant } from './seed';
import { WORKER_ACTIVITY_INPUTS, type ActivityContext, type WorkerName } from './inputs/worker-activities';

/**
 * Spec 19.3 / 5.2 cross-tenant harness for worker activities (ledger S.1), shared by the three workers'
 * `activities.cross-tenant.test.ts`. Each test file captures the activities its worker really registers (it starts
 * the worker with Temporal's Worker.create stubbed, so the registration code under test is the production one) and
 * hands them here. Every registered activity is then called the way Temporal calls it, with tenant A's context
 * (the owner as actor, or tenant A's service principal where the workflow runs as one) and tenant B's ids. It must
 * refuse (a non-retryable PolicyDenied / ValidationFailed failure, or a NOT_FOUND / FORBIDDEN / VALIDATION_FAILED
 * domain error) or, where the fixture allows it, complete as a no-op that returns no foreign data; and no row of
 * tenant B may change (every column of every tenant-scoped table, not only row counts: activities move state).
 * A registered activity without a fixture fails.
 */
export interface WorkerRegistration {
  taskQueue: string;
  activities: object;
}

/** `publish-<providerKey>` queues all register the provider activities; the fixture key names the queue family. */
export const activityKey = (taskQueue: string, name: string): string =>
  `${taskQueue.startsWith('publish-') ? 'publish-<provider>' : taskQueue}.${name}`;

type ActivityFn = (input: unknown) => Promise<unknown>;

export function registeredActivities(registrations: WorkerRegistration[]): Map<string, ActivityFn> {
  const out = new Map<string, ActivityFn>();
  for (const { taskQueue, activities } of registrations)
    for (const [name, fn] of Object.entries(activities))
      if (typeof fn === 'function' && !out.has(activityKey(taskQueue, name)))
        out.set(activityKey(taskQueue, name), fn as ActivityFn);
  return out;
}

const TENANT_TABLES: Array<[name: string, table: MySqlTable, tenantCol: MySqlColumn]> = Object.values(
  schema as Record<string, unknown>,
)
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .flatMap((table) => {
    const tenantCol = Object.values(getTableColumns(table)).find((c) => c.name === 'tenant_id');
    return tenantCol ? [[getTableName(table), table, tenantCol] as [string, MySqlTable, MySqlColumn]] : [];
  });

/** Every row of every tenant-scoped table of the tenant, keyed by table (a diff names the table and the row). */
async function tenantRows(db: Db, tenantId: string): Promise<Record<string, unknown[]>> {
  return Object.fromEntries(
    await Promise.all(
      TENANT_TABLES.map(async ([name, table, tenantCol]) => {
        const rows = await db.select().from(table).where(eq(tenantCol, tenantId));
        const sorted = rows.map((r) => JSON.stringify(r)).sort();
        return [name, sorted] as const;
      }),
    ),
  );
}

const REFUSAL_FAILURE_TYPES = ['PolicyDenied', 'ValidationFailed'];
const REFUSAL_CODES = ['NOT_FOUND', 'FORBIDDEN', 'VALIDATION_FAILED'];

/** The refusal an activity raised, or null for anything else (a retryable error, INTERNAL, a plain Error). */
export function refusalOf(err: unknown): string | null {
  const failure = err as { name?: string; type?: string; nonRetryable?: boolean } | null;
  if (failure?.name === 'ApplicationFailure' && failure.nonRetryable && failure.type)
    return REFUSAL_FAILURE_TYPES.includes(failure.type) ? failure.type : null;
  if (isOremediaError(err)) return REFUSAL_CODES.includes(err.code) ? err.code : null;
  return null;
}

const describeError = (err: unknown): string => {
  const e = err as { name?: string; type?: string; code?: string; message?: string } | null;
  return `${e?.name ?? typeof err}${e?.type ? `(${e.type})` : ''}${e?.code ? `[${e.code}]` : ''}: ${e?.message ?? String(err)}`;
};

/** Rows the fixtures reference that no module seed provides: one deletion request per tenant. */
async function seedActivityRows(db: Db, tenant: SeededTenant): Promise<Record<string, string>> {
  const deletionRequestId = newId('deletionRequest');
  await db.insert(deletionRequests).values({
    id: deletionRequestId,
    tenantId: tenant.tenantId,
    subjectType: 'asset',
    subjectId: tenant.ids['assetId'] ?? tenant.brandIds[0],
    reason: 'cross-tenant harness',
    requestedByKind: 'user',
    requestedById: tenant.ownerUserId,
    state: 'requested',
    fanout: {},
  });
  return { deletionRequestId };
}

export function describeActivityHarness(worker: WorkerName, registrations: () => WorkerRegistration[]): void {
  const fixtures = WORKER_ACTIVITY_INPUTS[worker];
  const keys = Object.keys(fixtures);

  describe(`cross-tenant harness: ${worker} activities (spec 19.3, 5.2)`, () => {
    let tdb: TestDatabase;
    let tenantA: SeededTenant;
    let tenantB: SeededTenant;
    let own: SeededTenant['ids'];
    let foreign: SeededTenant['ids'];

    beforeAll(async () => {
      tdb = await createTestDatabase();
      ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
      own = { ...tenantA.ids, ...(await seedActivityRows(tdb.db, tenantA)) };
      foreign = { ...tenantB.ids, ...(await seedActivityRows(tdb.db, tenantB)) };
    });
    afterAll(async () => {
      await tdb?.drop();
    });

    it('every registered activity has a cross-tenant fixture (a newly registered activity without one fails CI)', () => {
      const registered = [...registeredActivities(registrations()).keys()];
      expect(registered.length).toBeGreaterThan(0);
      const missing = registered.filter((k) => !(k in fixtures));
      expect(
        missing,
        `add fixtures in tooling/test-fixtures/src/inputs/worker-activities.ts (${worker}) for: ${missing.join(', ')}`,
      ).toEqual([]);
      const stale = keys.filter((k) => !registered.includes(k));
      expect(stale, `fixtures for activities ${worker} no longer registers`).toEqual([]);
      for (const [key, fixture] of Object.entries(fixtures))
        if (!fixture.buildInput || fixture.noOp)
          expect(fixture.reason, `${key} needs a documented reason`).toBeTruthy();
    });

    it.each(keys.map((key) => ({ key })))('$key refuses foreign tenant resources', async ({ key }) => {
      const fixture = fixtures[key];
      const fn = registeredActivities(registrations()).get(key);
      expect(fixture && fn, `${key} is registered and has a fixture`).toBeTruthy();
      if (!fixture?.buildInput || !fn) return; // documented: takes no tenant-scoped id
      const ctx: ActivityContext = {
        tenantId: tenantA.tenantId,
        actor:
          fixture.actor === 'service_principal'
            ? { kind: 'service_principal', id: tenantA.servicePrincipalId }
            : { kind: 'user', id: tenantA.ownerUserId },
        correlationId: `cross-tenant-activity-${key}`.slice(0, 64),
      };
      const before = await tenantRows(tdb.db, tenantB.tenantId);
      let outcome: { ok: true; result: unknown } | { ok: false; err: unknown };
      try {
        outcome = { ok: true, result: await fn(fixture.buildInput(ctx, foreign, own)) };
      } catch (err) {
        outcome = { ok: false, err };
      }
      if (!outcome.ok)
        expect(refusalOf(outcome.err), `${key} did not refuse: ${describeError(outcome.err)}`).not.toBeNull();
      else {
        expect(
          fixture.noOp,
          `${key} completed for foreign ids: ${JSON.stringify(outcome.result)?.slice(0, 500)}`,
        ).toBeDefined();
        expect(fixture.noOp?.(outcome.result), `${key} returned foreign data`).toEqual([]);
      }
      expect(await tenantRows(tdb.db, tenantB.tenantId)).toEqual(before); // nothing changed in tenant B
    });
  });
}
