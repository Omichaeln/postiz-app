import type { z } from 'zod';
import type { RetentionClassResultV1, RetentionDataClass } from '@oremedia/contracts/operations';
import { TenantScopedRepository, type Tx } from '@oremedia/db';
import { retentionPolicies } from '@oremedia/db/schema/operations';
import { audit, type AuditActor } from './audit';

type DataClass = z.infer<typeof RetentionDataClass>;

/**
 * Spec 17.5 defaults (to confirm under D-09) for the classes a TTL job applies. The other classes are deleted by an
 * event, not by age: user identity (account deletion), asset files (tenant deletion or rights expiry), creative
 * revisions (brand deletion), audit and release evidence (archive tier, 7 years), social tokens (destroyed at
 * disconnect or rotation, in the same transaction).
 */
export const RETENTION_DEFAULT_DAYS: Readonly<Partial<Record<DataClass, number>>> = {
  agent_transcripts: 90,
  metrics: 761, // 25 months
  customer_voice_raw: 365,
};

/** One module's TTL for one data class: removes (or, in a dry run, counts) its rows older than the cut-off. */
export interface RetentionHandler {
  name: string;
  dataClass: DataClass;
  run(cutoff: Date, dryRun: boolean, tx: Tx): Promise<number>;
}

const handlers: RetentionHandler[] = [];

/** Modules register their TTL handlers at the composition root; re-registering a name replaces it. */
export function registerRetentionHandler(handler: RetentionHandler): void {
  const i = handlers.findIndex((h) => h.name === handler.name);
  if (i >= 0) handlers[i] = handler;
  else handlers.push(handler);
}

export const retentionHandlers = (): readonly RetentionHandler[] => handlers;

/** Test seam. */
export function clearRetentionHandlers(): void {
  handlers.length = 0;
}

/** The tenants the sweep visits (a platform-level read the composition root provides). */
export type RetentionTenantSource = (correlationId: string) => Promise<string[]>;
let tenantSource: RetentionTenantSource | null = null;
export function registerRetentionTenantSource(source: RetentionTenantSource | null): void {
  tenantSource = source;
}

class RetentionPolicyRepository extends TenantScopedRepository<typeof retentionPolicies> {
  constructor() {
    super(retentionPolicies);
  }
  async list(tx?: Tx) {
    return this.conn(tx).select().from(retentionPolicies).where(this.scope());
  }
}
const policies = new RetentionPolicyRepository();

const DAY_MS = 86_400_000;

/** Spec 17.5 TTL job (retentionSweepWorkflowV1): applies the tenant's retention_policies, else the defaults. */
export const retention = {
  async tenants(correlationId: string): Promise<string[]> {
    if (!tenantSource) throw new Error('retention tenant source is not registered (composition root)');
    return [...new Set(await tenantSource(correlationId))];
  },

  /** Days for a class in the current tenant: the policy row (null = keep indefinitely) or the default. */
  async days(tx?: Tx): Promise<Partial<Record<DataClass, number | null>>> {
    const out: Partial<Record<DataClass, number | null>> = { ...RETENTION_DEFAULT_DAYS };
    for (const p of await policies.list(tx)) out[p.dataClass] = p.retentionDays;
    return out;
  },

  /**
   * Runs every registered TTL handler for the current tenant in this transaction. A dry run counts and deletes
   * nothing; a real run is audited per class with the row count. A class with no retention (null) is skipped.
   */
  async apply(actor: AuditActor, now: Date, dryRun: boolean, tx: Tx): Promise<RetentionClassResultV1[]> {
    const days = await retention.days(tx);
    const results: RetentionClassResultV1[] = [];
    for (const h of handlers) {
      const d = days[h.dataClass];
      if (d === null || d === undefined) continue;
      const cutoff = new Date(now.getTime() - d * DAY_MS);
      const rows = await h.run(cutoff, dryRun, tx);
      results.push({
        dataClass: h.dataClass,
        handler: h.name,
        retentionDays: d,
        cutoff: cutoff.toISOString(),
        rows,
      });
      if (!dryRun && rows > 0)
        await audit.record(
          actor,
          'retention.apply',
          { type: 'retention_class', id: h.dataClass },
          'allowed',
          tx,
          {
            scope: h.name,
            count: rows,
          },
        );
    }
    return results;
  },
};
