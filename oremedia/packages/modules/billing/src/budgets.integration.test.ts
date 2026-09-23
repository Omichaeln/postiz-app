import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { BudgetExhaustedError } from '@oremedia/contracts/errors';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, type TenantContext } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { budgetReservations, usageLedger } from '@oremedia/db/schema/billing';
import { newId } from '@oremedia/domain/ids';
import { budgets } from './budgets';
import { entitlements } from './entitlements';

const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'service_principal', id: 'sp_1' },
  brandIds: 'all',
  correlationId: 'corr_budget',
});

describe('budgets (spec 12.6) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const brandA = newId('brand');
  const deadline = new Date(Date.now() + 3600_000);

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: 'bud-' + tenantA.slice(-6).toLowerCase() });
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('entitlements resolve to the pilot plan when no subscription exists; check() returns reasons', async () => {
    await runInTenant(ctx(tenantA), async () => {
      const set = await entitlements.resolve(tenantA);
      expect(set.limits.brands).toBe(5);
      expect(set.features.managed_autopublish).toBe(false);
      expect((await entitlements.check(tenantA, 'managed_autopublish')).reason).toBe('feature_not_in_plan');
      expect((await entitlements.check(tenantA, 'experiments')).allowed).toBe(true);
      expect((await entitlements.check(tenantA, 'channels')).allowed).toBe(true);
    });
  });

  it('parallel reservations cannot overspend the brand-day limit', async () => {
    await runInTenant(ctx(tenantA), () => budgets.setLimit(brandA, 'day', 10_000_000));
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        runInTenant(ctx(tenantA), () => budgets.reserveSpend(brandA, newId('agentRun'), 3_000_000, deadline)),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const exhausted = results.filter(
      (r) => r.status === 'rejected' && (r as PromiseRejectedResult).reason instanceof BudgetExhaustedError,
    ).length;
    expect(ok).toBe(3); // 3 × 3,000,000 ≤ 10,000,000 < 4 × 3,000,000
    expect(exhausted).toBe(5);
    const held = await tdb.db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.tenantId, tenantA));
    expect(held.reduce((s, r) => s + r.reservedMicros, 0)).toBeLessThanOrEqual(10_000_000);
  });

  it('consumption is ledgered; exceeding the reservation ends with budget_exhausted; settle releases the remainder', async () => {
    const runId = newId('agentRun');
    await runInTenant(ctx(tenantA), async () => {
      await budgets.setLimit(brandA, 'day', 100_000_000);
      const r = await budgets.reserveSpend(brandA, runId, 1_000_000, deadline);
      await budgets.consume(r.id, brandA, 'model_tokens', 1200, 'tokens', 400_000, 'step_1');
      await budgets.consume(r.id, brandA, 'tool_call', 1, 'call', 100_000, 'step_2');
      await expect(
        budgets.consume(r.id, brandA, 'image_generation', 1, 'image', 800_000, 'step_3'),
      ).rejects.toBeInstanceOf(BudgetExhaustedError);
      await budgets.settle(runId);
      const row = (
        await tdb.db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId))
      )[0]!;
      expect(row.state).toBe('settled');
      expect(row.consumedMicros).toBe(1_300_000);
      const ledger = await tdb.db.select().from(usageLedger).where(eq(usageLedger.reservationId, r.id));
      expect(ledger.length).toBe(3);
      await budgets.settle(runId); // idempotent
    });
  });
});
