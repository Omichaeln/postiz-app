import { and, eq, inArray, sql } from 'drizzle-orm';
import { BudgetExhaustedError } from '@oremedia/contracts/errors';
import { TenantScopedRepository, requireTenant, withTransaction, type Tx } from '@oremedia/db';
import { budgetReservations, spendLimits, usageLedger } from '@oremedia/db/schema/billing';
import { newId } from '@oremedia/domain/ids';
import { count, METRIC, record } from '@oremedia/observability';
import { dayKey, entitlements, monthKey } from './entitlements';

/**
 * Spec 12.6: reserveSpend inserts a budget_reservations row inside a transaction that checks
 * sum(held + consumed) + estimate ≤ limit for the period, locking the tenant's budget row
 * (SELECT ... FOR UPDATE on spend_limits). Parallel runs cannot overspend.
 *
 * The limit rows are ensured to exist in their own short transaction *before* the reservation transaction, so
 * the reservation only ever locks existing rows (no gap-lock races between concurrent first reservations).
 */
class SpendLimitRepository extends TenantScopedRepository<typeof spendLimits> {
  constructor() {
    super(spendLimits);
  }
  async ensure(brandId: string, period: 'day' | 'month', defaultMicros: number): Promise<void> {
    const { tenantId } = requireTenant();
    await this.conn()
      .insert(spendLimits)
      .values({ id: newId('spendLimit'), tenantId, brandId, period, limitMicros: defaultMicros })
      .onDuplicateKeyUpdate({ set: { tenantId: sql`${spendLimits.tenantId}` } });
  }
  async lock(brandId: string, period: 'day' | 'month', tx: Tx): Promise<{ id: string; limitMicros: number }> {
    const rows = await tx
      .select()
      .from(spendLimits)
      .where(this.scope(and(eq(spendLimits.brandId, brandId), eq(spendLimits.period, period))))
      .for('update');
    const row = rows[0];
    if (!row) throw new Error(`spend limit row missing for ${brandId}/${period}`);
    return { id: row.id, limitMicros: row.limitMicros };
  }
  async set(brandId: string, period: 'day' | 'month', limitMicros: number, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(spendLimits)
      .where(this.scope(and(eq(spendLimits.brandId, brandId), eq(spendLimits.period, period))));
    const row = rows[0];
    if (row) await this.updateScoped(row.id, row.version, { limitMicros }, tx);
    else await this.insertScoped({ id: newId('spendLimit'), brandId, period, limitMicros }, tx);
  }
}

class ReservationRepository extends TenantScopedRepository<typeof budgetReservations> {
  constructor() {
    super(budgetReservations);
  }
  async committedMicros(
    scope: { brandId: string; dayKey: string } | { periodKey: string },
    tx: Tx,
  ): Promise<number> {
    const states = inArray(budgetReservations.state, ['held', 'settled']);
    const where =
      'dayKey' in scope
        ? and(
            states,
            eq(budgetReservations.brandId, scope.brandId),
            eq(budgetReservations.dayKey, scope.dayKey),
          )
        : and(states, eq(budgetReservations.periodKey, scope.periodKey));
    const rows = await tx
      .select({
        total: sql<number>`coalesce(sum(greatest(${budgetReservations.reservedMicros}, ${budgetReservations.consumedMicros})), 0)`,
      })
      .from(budgetReservations)
      .where(this.scope(where));
    return Number(rows[0]?.total ?? 0);
  }
  async byRun(runId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(budgetReservations)
      .where(this.scope(eq(budgetReservations.runId, runId)))
      .limit(1);
    return rows[0] ?? null;
  }
  async create(values: Omit<typeof budgetReservations.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof budgetReservations.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
}

class LedgerRepository extends TenantScopedRepository<typeof usageLedger> {
  constructor() {
    super(usageLedger);
  }
  async append(values: Omit<typeof usageLedger.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
}

const limitsRepo = new SpendLimitRepository();
const reservations = new ReservationRepository();
const ledger = new LedgerRepository();

const DEFAULT_BRAND_DAY_MICROS = 20_000_000; // USD 20 per brand per day (placeholder, D-08)

export interface Reservation {
  id: string;
  reservedMicros: number;
}

export const budgets = {
  /** Atomic reservation against per-brand-per-day and per-tenant-per-month limits. Throws BudgetExhausted. */
  async reserveSpend(
    brandId: string,
    runId: string,
    estimateMicros: number,
    deadline: Date,
  ): Promise<Reservation> {
    const { tenantId } = requireTenant();
    const ent = await entitlements.resolve(tenantId);
    const monthLimit = ent.limits.generation_budget_micros_month ?? 0;
    await limitsRepo.ensure('', 'month', monthLimit);
    await limitsRepo.ensure(brandId, 'day', DEFAULT_BRAND_DAY_MICROS);
    return withTransaction(async (tx) => {
      // Lock order: tenant month row, then brand day row (consistent across callers to avoid deadlocks).
      const tenantMonth = await limitsRepo.lock('', 'month', tx);
      const brandDay = await limitsRepo.lock(brandId, 'day', tx);
      const monthCommitted = await reservations.committedMicros({ periodKey: monthKey() }, tx);
      if (monthCommitted + estimateMicros > Math.min(tenantMonth.limitMicros, monthLimit))
        throw new BudgetExhaustedError('tenant_month');
      const dayCommitted = await reservations.committedMicros({ brandId, dayKey: dayKey() }, tx);
      if (dayCommitted + estimateMicros > brandDay.limitMicros) throw new BudgetExhaustedError('brand_day');
      const id = newId('budgetReservation');
      await reservations.create(
        {
          id,
          brandId,
          runId,
          reservedMicros: estimateMicros,
          consumedMicros: 0,
          state: 'held',
          periodKey: monthKey(),
          dayKey: dayKey(),
          expiresAt: deadline,
        },
        tx,
      );
      return { id, reservedMicros: estimateMicros };
    });
  },

  /**
   * Records consumption per model or tool call. Cost already incurred is always ledgered; when the reservation
   * is exceeded the ledger entry commits first and the run then ends with budget_exhausted (spec 12.6).
   */
  async consume(
    reservationId: string,
    brandId: string,
    kind: typeof usageLedger.$inferInsert.kind,
    quantity: number,
    unit: string,
    costMicros: number,
    sourceRef: string,
  ): Promise<void> {
    const exceeded = await withTransaction(async (tx) => {
      const r = await reservations.getById(reservationId, tx);
      if (r.state !== 'held') throw new BudgetExhaustedError('reservation_closed');
      const consumed = r.consumedMicros + costMicros;
      await reservations.update(r.id, r.version, { consumedMicros: consumed }, tx);
      await ledger.append(
        {
          id: newId('usageLedger'),
          brandId,
          kind,
          quantity,
          unit,
          costMicros,
          sourceRef,
          reservationId,
          periodKey: monthKey(),
        },
        tx,
      );
      if (consumed > r.reservedMicros) {
        count(METRIC.modelSpendDriftMicros, consumed - r.reservedMicros, { scope: 'over' });
        return true;
      }
      return false;
    });
    if (exceeded) throw new BudgetExhaustedError('run');
  },

  /** Settles on completion and releases the remainder. Idempotent. */
  async settle(runId: string): Promise<void> {
    await withTransaction(async (tx) => {
      const r = await reservations.byRun(runId, tx);
      if (!r || r.state !== 'held') return;
      await reservations.update(r.id, r.version, { state: 'settled', reservedMicros: r.consumedMicros }, tx);
      record(METRIC.modelSpendDriftMicros, r.consumedMicros - r.reservedMicros, { scope: 'settled' });
    });
  },

  /** Releases the remainder of a held reservation; joins the caller's unit of work when given one. Idempotent. */
  async release(runId: string, tx?: Tx): Promise<void> {
    await withTransaction(tx, async (t) => {
      const r = await reservations.byRun(runId, t);
      if (!r || r.state !== 'held') return;
      await reservations.update(r.id, r.version, { state: 'released', reservedMicros: r.consumedMicros }, t);
    });
  },

  setLimit: (brandId: string | null, period: 'day' | 'month', limitMicros: number, tx?: Tx) =>
    limitsRepo.set(brandId ?? '', period, limitMicros, tx),
};
