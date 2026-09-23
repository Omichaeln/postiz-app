import {
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { PlanLimits } from '@oremedia/contracts/billing';
import { createdAt, id, micros, ref, tenantId, ts, updatedAt, version } from './_columns';
import { tenants } from './access';

/** Global catalogue. Listed in GLOBAL_TABLES. */
export const plans = mysqlTable('plans', {
  id: id(),
  key: varchar('key', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  limits: json('limits').$type<PlanLimits>().notNull(),
  priceMicrosMonth: micros('price_micros_month').notNull().default(0),
  currency: varchar('currency', { length: 3 }).notNull().default('USD'),
  state: mysqlEnum('state', ['active', 'grandfathered', 'retired']).notNull().default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  version: version(),
});

export const subscriptions = mysqlTable(
  'subscriptions',
  {
    id: id(),
    tenantId: tenantId(),
    planId: ref('plan_id').notNull(),
    state: mysqlEnum('state', ['trial', 'active', 'past_due', 'grace', 'cancelled']).notNull(),
    trialEndsAt: ts('trial_ends_at'),
    graceEndsAt: ts('grace_ends_at'),
    currentPeriodStart: ts('current_period_start').notNull(),
    currentPeriodEnd: ts('current_period_end').notNull(),
    externalRef: varchar('external_ref', { length: 200 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_subscription_tenant').on(t.tenantId),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id], name: 'fk_subscription_tenant' }),
  ],
);

/** Per-tenant overrides on top of plan limits (support-granted, time-boxed). */
export const entitlements = mysqlTable(
  'entitlements',
  {
    id: id(),
    tenantId: tenantId(),
    feature: varchar('feature', { length: 60 }).notNull(),
    limitValue: int('limit_value'),
    enabled: mysqlEnum('enabled', ['yes', 'no']),
    reason: varchar('reason', { length: 300 }).notNull(),
    expiresAt: ts('expires_at'),
    grantedByUserId: ref('granted_by_user_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_entitlement_feature').on(t.tenantId, t.feature),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id], name: 'fk_entitlement_tenant' }),
  ],
);

/** Locked with SELECT ... FOR UPDATE during reservation (spec 12.6). brand_id '' = tenant-wide. */
export const spendLimits = mysqlTable(
  'spend_limits',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: varchar('brand_id', { length: 32 }).notNull().default(''),
    period: mysqlEnum('period', ['day', 'month']).notNull(),
    limitMicros: micros('limit_micros').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_spend_limit').on(t.tenantId, t.brandId, t.period),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id], name: 'fk_spend_limit_tenant' }),
  ],
);

export const budgetReservations = mysqlTable(
  'budget_reservations',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: varchar('brand_id', { length: 32 }).notNull(),
    runId: ref('run_id').notNull(),
    reservedMicros: micros('reserved_micros').notNull(),
    consumedMicros: micros('consumed_micros').notNull().default(0),
    state: mysqlEnum('state', ['held', 'settled', 'released']).notNull().default('held'),
    periodKey: varchar('period_key', { length: 16 }).notNull(), // e.g. 2026-09 (month) for limit arithmetic
    dayKey: varchar('day_key', { length: 10 }).notNull(), // e.g. 2026-09-23 for the per-brand-per-day limit
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_budget_reservation_run').on(t.tenantId, t.runId),
    index('ix_budget_reservation_period').on(t.tenantId, t.brandId, t.periodKey, t.state),
    index('ix_budget_reservation_day').on(t.tenantId, t.brandId, t.dayKey, t.state),
  ],
);

/** Insert-only. */
export const usageLedger = mysqlTable(
  'usage_ledger',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: varchar('brand_id', { length: 32 }).notNull(),
    kind: mysqlEnum('kind', [
      'model_tokens',
      'tool_call',
      'image_generation',
      'render_minutes',
      'storage_bytes',
    ]).notNull(),
    quantity: int('quantity').notNull(),
    unit: varchar('unit', { length: 20 }).notNull(),
    costMicros: micros('cost_micros').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    sourceRef: varchar('source_ref', { length: 200 }).notNull(),
    reservationId: ref('reservation_id'),
    periodKey: varchar('period_key', { length: 16 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_usage_period').on(t.tenantId, t.brandId, t.periodKey, t.kind)],
);
