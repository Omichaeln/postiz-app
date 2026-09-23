import { and, eq, type SQL } from 'drizzle-orm';
import type { MySqlColumn, MySqlTable } from 'drizzle-orm/mysql-core';
import { ConflictError, NotFoundError, PolicyDeniedError } from '@oremedia/contracts';
import { getDb, type Tx } from './client';
import { requireTenant } from './tenant-context';

type TenantTable = MySqlTable & { tenantId: MySqlColumn; id: MySqlColumn };
type BrandTable = TenantTable & { brandId: MySqlColumn };

/** Normalises driver result shapes (mysql2 ResultSetHeader). Pin one driver per deployment. */
export function affectedRows(res: unknown): number {
  if (Array.isArray(res)) {
    const head = res[0] as { affectedRows?: number } | undefined;
    return head?.affectedRows ?? 0;
  }
  const obj = res as { affectedRows?: number; rowsAffected?: number } | undefined;
  return obj?.affectedRows ?? obj?.rowsAffected ?? 0;
}

/**
 * Spec 5.3: feature code never touches the raw Drizzle handle. Every read, update and delete carries
 * the tenant predicate; every insert is stamped with tenant_id. There is no unscoped variant.
 */
export abstract class TenantScopedRepository<T extends TenantTable> {
  protected constructor(protected readonly table: T) {}

  /** Every query starts here. There is no unscoped variant. */
  protected scope(extra?: SQL): SQL {
    const { tenantId } = requireTenant();
    const tenantClause = eq(this.table.tenantId, tenantId);
    return extra ? (and(tenantClause, extra) as SQL) : tenantClause;
  }

  protected conn(tx?: Tx) {
    return tx ?? getDb();
  }

  protected get resourceName(): string {
    return this.constructor.name.replace(/Repository$/, '');
  }

  async findById(id: string, tx?: Tx): Promise<T['$inferSelect'] | null> {
    const rows = await this.conn(tx)
      .select()
      .from(this.table as MySqlTable)
      .where(this.scope(eq(this.table.id, id)))
      .limit(1);
    return (rows[0] as T['$inferSelect'] | undefined) ?? null;
  }

  /** Throws NOT_FOUND for ids that exist in another tenant: never reveal existence. */
  async getById(id: string, tx?: Tx): Promise<T['$inferSelect']> {
    const row = await this.findById(id, tx);
    if (!row) throw new NotFoundError(this.resourceName, id);
    return row;
  }

  protected async insertScoped(values: Omit<T['$inferInsert'], 'tenantId'>, tx?: Tx): Promise<void> {
    const { tenantId } = requireTenant();
    await this.conn(tx)
      .insert(this.table as MySqlTable)
      .values({ ...(values as object), tenantId } as T['$inferInsert']);
  }

  /** Updates are always id + tenant + expected version (optimistic concurrency). */
  protected async updateScoped(
    id: string,
    expectedVersion: number,
    values: Partial<T['$inferInsert']>,
    tx?: Tx,
  ): Promise<void> {
    const versionColumn = (this.table as unknown as { version?: MySqlColumn }).version;
    if (!versionColumn)
      throw new Error(`${this.resourceName} has no version column; use an insert-only repository`);
    const res = await this.conn(tx)
      .update(this.table as MySqlTable)
      .set({ ...(values as object), version: expectedVersion + 1 } as never)
      .where(this.scope(and(eq(this.table.id, id), eq(versionColumn, expectedVersion))));
    if (affectedRows(res) !== 1) throw new ConflictError(this.resourceName, id, expectedVersion);
  }

  /** Scoped delete for the few mutable, non-evidence rows that are truly removable (e.g. upload intents). */
  protected async deleteScoped(id: string, tx?: Tx): Promise<boolean> {
    const res = await this.conn(tx)
      .delete(this.table as MySqlTable)
      .where(this.scope(eq(this.table.id, id)));
    return affectedRows(res) === 1;
  }
}

/** Brand-owned repositories additionally require brandId ∈ ctx.brandIds (spec 5.3). */
export abstract class BrandScopedRepository<T extends BrandTable> extends TenantScopedRepository<T> {
  protected assertBrandAccess(brandId: string): void {
    const ctx = requireTenant();
    if (ctx.brandIds !== 'all' && !ctx.brandIds.has(brandId)) {
      // A brand the actor cannot see behaves like a brand that does not exist.
      throw new NotFoundError('Brand', brandId);
    }
  }

  protected brandScope(brandId: string, extra?: SQL): SQL {
    this.assertBrandAccess(brandId);
    const clause = eq(this.table.brandId, brandId);
    return this.scope(extra ? (and(clause, extra) as SQL) : clause);
  }

  override async findById(id: string, tx?: Tx): Promise<T['$inferSelect'] | null> {
    const row = await super.findById(id, tx);
    if (!row) return null;
    const ctx = requireTenant();
    const brandId = (row as { brandId: string }).brandId;
    if (ctx.brandIds !== 'all' && !ctx.brandIds.has(brandId)) return null;
    return row;
  }

  protected async insertBrandScoped(
    values: Omit<T['$inferInsert'], 'tenantId'> & { brandId: string },
    tx?: Tx,
  ): Promise<void> {
    this.assertBrandAccess(values.brandId);
    await this.insertScoped(values, tx);
  }
}

/**
 * Cross-tenant jobs (billing roll-ups, platform metrics) use PlatformRepository, available only in the
 * operations module, reading aggregate projections, audited, and never returning tenant content (spec 5.3).
 */
export abstract class PlatformRepository {
  protected conn(tx?: Tx) {
    const ctx = requireTenantOrPlatform();
    if (ctx.kind !== 'platform') throw new PolicyDeniedError('platform_repository_requires_platform_context');
    return tx ?? getDb();
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
const platformStorage = new AsyncLocalStorage<{ kind: 'platform'; job: string; correlationId: string }>();

/** Platform jobs declare themselves explicitly; there is no implicit "no tenant = all tenants". */
export const runAsPlatform = <T>(job: string, correlationId: string, fn: () => Promise<T>): Promise<T> =>
  platformStorage.run({ kind: 'platform', job, correlationId }, fn);

function requireTenantOrPlatform(): { kind: 'platform'; job: string } | { kind: 'tenant' } {
  const p = platformStorage.getStore();
  if (p) return p;
  requireTenant();
  return { kind: 'tenant' };
}

export const currentPlatformJob = () => platformStorage.getStore();
