import { eq, gt, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { PlanLimits } from '@oremedia/contracts/billing';
import { EntitlementExceededError } from '@oremedia/contracts/errors';
import type { EntitlementFeature, EntitlementSet } from '@oremedia/contracts/policy';
import {
  PlatformRepository,
  TenantScopedRepository,
  runAsPlatform,
  requireTenant,
  type Tx,
} from '@oremedia/db';
import {
  entitlements as entitlementRows,
  plans,
  subscriptions,
  usageLedger,
} from '@oremedia/db/schema/billing';

/**
 * Spec 22.1: a single checkEntitlement(tenant, feature) returns allowed/denied with a reason. Plans are long-lived,
 * billing-coupled entitlements; feature flags (operations module) are short-lived engineering switches.
 *
 * Written behaviour for the awkward states (D-08 placeholders, labelled):
 *  - trial expiry: plan limits stay; generation paused (generation budget = 0) until a subscription is active;
 *  - downgrade over limit: excess brands are read-only, nothing is deleted (enforced by the brand module's
 *    write checks against `brands` usage vs limit);
 *  - billing failure grace (14 days): publishing continues, generation paused.
 */
export const PILOT_PLAN: PlanLimits = {
  brands: 5,
  seats: 10,
  channels: 10,
  generationBudgetMicrosMonth: 200_000_000, // USD 200
  renderMinutesMonth: 600,
  analystFrequency: 'weekly',
  experiments: true,
  inboxSeats: 0,
  managedAutopublish: false,
};

class PlanReader extends PlatformRepository {
  async subscriptionWithPlan(tenantId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select({ subscription: subscriptions, plan: plans })
      .from(subscriptions)
      .innerJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(subscriptions.tenantId, tenantId))
      .limit(1);
    return rows[0] ?? null;
  }
}

class EntitlementOverrides extends TenantScopedRepository<typeof entitlementRows> {
  constructor() {
    super(entitlementRows);
  }
  async active(tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(entitlementRows)
      .where(
        this.scope(or(isNull(entitlementRows.expiresAt), gt(entitlementRows.expiresAt, new Date())) as SQL),
      );
  }
}

class UsageReader extends TenantScopedRepository<typeof usageLedger> {
  constructor() {
    super(usageLedger);
  }
  async spentMicrosInPeriod(periodKey: string, tx?: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ total: sql<number>`coalesce(sum(${usageLedger.costMicros}), 0)` })
      .from(usageLedger)
      .where(this.scope(eq(usageLedger.periodKey, periodKey))); // every kind: model tokens and generated images alike
    return Number(rows[0]?.total ?? 0);
  }
}

const planReader = new PlanReader();
const overrides = new EntitlementOverrides();
const usage = new UsageReader();

export const monthKey = (d = new Date()): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
export const dayKey = (d = new Date()): string => d.toISOString().slice(0, 10);

/** Usage counters are supplied by the modules that own the counted rows, to keep table ownership intact. */
export interface UsageCounters {
  brands?: number;
  seats?: number;
  channels?: number;
}
let usageCounterSource: ((tenantId: string, tx?: Tx) => Promise<UsageCounters>) | null = null;
export const registerUsageCounters = (fn: (tenantId: string, tx?: Tx) => Promise<UsageCounters>): void => {
  usageCounterSource = fn;
};

export const entitlements = {
  async resolve(tenantId: string, tx?: Tx): Promise<EntitlementSet> {
    const ctx = requireTenant();
    const sub = await runAsPlatform('entitlements', ctx.correlationId, () =>
      planReader.subscriptionWithPlan(tenantId, tx),
    );
    const limits: PlanLimits = sub ? sub.plan.limits : PILOT_PLAN;
    const state = sub?.subscription.state ?? 'trial';
    const now = Date.now();
    const trialExpired =
      state === 'trial' &&
      sub?.subscription.trialEndsAt !== null &&
      sub?.subscription.trialEndsAt !== undefined &&
      sub.subscription.trialEndsAt.getTime() < now;
    const generationPaused =
      trialExpired || state === 'past_due' || state === 'grace' || state === 'cancelled';
    const set: EntitlementSet = {
      limits: {
        brands: limits.brands,
        seats: limits.seats,
        channels: limits.channels,
        generation_budget_micros_month: generationPaused ? 0 : limits.generationBudgetMicrosMonth,
        render_minutes_month: limits.renderMinutesMonth,
        inbox_seats: limits.inboxSeats,
      },
      features: { experiments: limits.experiments, managed_autopublish: limits.managedAutopublish },
      usage: {},
    };
    for (const o of await overrides.active(tx)) {
      const f = o.feature as EntitlementFeature;
      if (o.limitValue !== null) set.limits[f] = o.limitValue;
      if (o.enabled !== null) set.features[f] = o.enabled === 'yes';
    }
    const counters = usageCounterSource ? await usageCounterSource(tenantId, tx) : {};
    set.usage.brands = counters.brands ?? 0;
    set.usage.seats = counters.seats ?? 0;
    set.usage.channels = counters.channels ?? 0;
    set.usage.generation_budget_micros_month = await usage.spentMicrosInPeriod(monthKey(), tx);
    return set;
  },

  /** Spec 22.1: allowed/denied with a reason. */
  async check(
    tenantId: string,
    feature: EntitlementFeature,
    tx?: Tx,
  ): Promise<{ allowed: boolean; reason: string; limit?: number; usage?: number }> {
    const set = await entitlements.resolve(tenantId, tx);
    if (feature in set.features) {
      const on = set.features[feature] === true;
      return { allowed: on, reason: on ? 'ok' : 'feature_not_in_plan' };
    }
    const limit = set.limits[feature];
    const used = set.usage[feature] ?? 0;
    if (limit === undefined) return { allowed: false, reason: 'feature_not_in_plan' };
    return used < limit
      ? { allowed: true, reason: 'ok', limit, usage: used }
      : { allowed: false, reason: 'limit_reached', limit, usage: used };
  },

  async assert(tenantId: string, feature: EntitlementFeature, tx?: Tx): Promise<void> {
    const r = await entitlements.check(tenantId, feature, tx);
    if (!r.allowed) throw new EntitlementExceededError(feature, r.reason);
  },
};
