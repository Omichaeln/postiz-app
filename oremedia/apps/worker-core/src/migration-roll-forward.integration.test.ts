import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, getTableColumns, getTableName, inArray, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import { randomUUID } from 'node:crypto';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
import { modelRoutingPolicies, providerJobs } from '@oremedia/db/schema/agents';
import { usageLedger } from '@oremedia/db/schema/billing';
import { featureFlags } from '@oremedia/db/schema/operations';
import { previewExports, renderPreviews } from '@oremedia/db/schema/creative';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { budgets } from '@oremedia/module-billing';
import { creativeService } from '@oremedia/module-creative';
import { seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src/seed';

/**
 * Ledger 1.g4: the new migration rolls forward on a populated database. The database is migrated to the previous
 * head (0001), populated with the cross-tenant fixture seed for two tenants plus usage ledger rows in the previous
 * shape (including a legacy double charge the new idempotency index must tolerate), then migrated to head. Every
 * existing row is unchanged, the new column is defaulted (NULL), the new tables exist and are empty, and the
 * migrated rows work with the new code paths.
 */
const PREVIOUS_HEAD = '0001_tool_invocation_proposal_payload';
/** What 0002 adds: columns on existing tables, and new tables. */
const ADDED_COLUMNS: Readonly<Record<string, readonly string[]>> = { usage_ledger: ['idempotency_key'] };
const NEW_TABLES = [providerJobs, modelRoutingPolicies, renderPreviews, previewExports];

const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;

const TABLES = (Object.values(schema) as unknown[])
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .filter((t) => !NEW_TABLES.includes(t as never));

describe('migrations roll forward on a populated database (ledger 1.g4)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  let before = '';

  /** Every pre-existing table's rows, in id order, over the columns that existed at the previous head. */
  async function snapshot(): Promise<string> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const name = getTableName(table);
      const columns = Object.fromEntries(
        Object.entries(getTableColumns(table)).filter(
          ([, c]) => !(ADDED_COLUMNS[name] ?? []).includes(c.name),
        ),
      ) as Record<string, MySqlColumn>;
      const order =
        Object.values(getTableColumns(table)).find((c) => c.name === 'id') ?? Object.values(columns)[0]!;
      out[name] = await tdb.db.select(columns).from(table).orderBy(asc(order));
    }
    return JSON.stringify(out);
  }

  beforeAll(async () => {
    tdb = await createTestDatabase({ migrationsUpTo: PREVIOUS_HEAD });
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
    // Usage rows as the previous head wrote them (no idempotency key), including one call charged twice by an
    // activity retry before this release: the new unique index must accept the NULL keys. Written with sql``, not
    // insert(usageLedger).values(): Drizzle lists every column of the current schema object, `idempotency_key`
    // included (as `default`), and that column does not exist at 0001, so the old-shape row cannot be expressed
    // through the current table object.
    for (const [t, sourceRef] of [
      [tenantA, 'step_retried'],
      [tenantA, 'step_retried'],
      [tenantB, 'step_other'],
    ] as const)
      await tdb.db.execute(
        sql`insert into ${usageLedger} (id, tenant_id, brand_id, kind, quantity, unit, cost_micros, currency, source_ref, reservation_id, period_key, created_at) values (${newId('ul')}, ${t.tenantId}, ${t.brandIds[0]}, 'image_generation', 1, 'call', 40000, 'USD', ${sourceRef}, null, '2026-09', now(3))`,
      );
    await expect(tdb.db.select().from(providerJobs)).rejects.toThrow(); // not there at the previous head
    before = await snapshot();
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('applies the new migration: existing rows are intact, the new column is defaulted, the new tables are empty', async () => {
    await tdb.migrateToHead();
    expect(await snapshot()).toBe(before);
    const ledger = await tdb.db
      .select()
      .from(usageLedger)
      .where(inArray(usageLedger.tenantId, [tenantA.tenantId, tenantB.tenantId]));
    expect(ledger).toHaveLength(3);
    expect(ledger.every((l) => l.idempotencyKey === null)).toBe(true);
    for (const t of NEW_TABLES) expect(await tdb.db.select().from(t)).toEqual([]);
  });

  it('the migrated rows work with the new code: an idempotent charge and a preview render of a seeded revision', async () => {
    const owner: ResolvedActor = {
      kind: 'user',
      id: tenantA.ownerUserId,
      tenantId: tenantA.tenantId,
      membershipId: tenantA.ownerMembershipId,
      membershipStatus: 'active',
      role: 'owner',
      allBrands: true,
      brandGrants: [],
      mfaEnrolled: false,
    };
    const ctx: TenantContext = {
      tenantId: tenantA.tenantId,
      actor: { kind: 'user', id: tenantA.ownerUserId },
      brandIds: 'all',
      correlationId: 'corr_roll_forward',
    };
    await runInTenant(ctx, async () => {
      const r = await budgets.reserveSpend(
        tenantA.brandIds[0],
        newId('run'),
        1_000_000,
        new Date(Date.now() + 3600_000),
      );
      for (let i = 0; i < 2; i++)
        await budgets.consume(
          r.id,
          tenantA.brandIds[0],
          'image_generation',
          1,
          'call',
          40_000,
          'step_new',
          'tool_call:x',
        );
    });
    const keyed = await tdb.db
      .select()
      .from(usageLedger)
      .where(inArray(usageLedger.idempotencyKey, ['tool_call:x']));
    expect(keyed).toHaveLength(1);

    await tdb.db.insert(featureFlags).values({
      key: 'creative.preview_render',
      enabledDefault: false,
      targeting: { tenantIds: [tenantA.tenantId] },
      owner: 'creative',
      removalDate: new Date('2027-03-31T00:00:00Z'),
      successMetric: 'test',
    });
    const proposal = await runInTenant(ctx, () =>
      withTransaction((tx) =>
        creativeService.operations.propose(
          owner,
          {
            documentId: tenantA.ids['creativeDocumentId']!,
            baseRevisionId: tenantA.ids['creativeRevisionId']!,
            operations: [
              {
                op: 'moveElement',
                pageId: 'page_1',
                elementId: tenantA.ids['creativeElementId']!,
                x: 120,
                y: 120,
              },
            ],
            summary: 'nudge',
            origin: 'user',
            previewRender: { formatKeys: ['square_1080'] },
          },
          tx,
        ),
      ),
    );
    expect(proposal.preview.renderJobId).toMatch(/^rj_/);
    expect(await tdb.db.select().from(renderPreviews)).toMatchObject([
      {
        tenantId: tenantA.tenantId,
        renderJobId: proposal.preview.renderJobId,
        contentHash: proposal.contentHash,
      },
    ]);
  });
});
