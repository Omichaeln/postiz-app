import { and, eq, getTableColumns, getTableName, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { MySqlTable, getTableConfig, type MySqlColumn } from 'drizzle-orm/mysql-core';
import { getDb, type Tx } from './client';
import * as schema from './schema';
import { affectedRows } from './scoped-repository';
import { requireTenant } from './tenant-context';

/** What one purge touches: the current tenant, optionally one brand, optionally rows older than a cut-off. */
export interface PurgeScope {
  brandId?: string;
  olderThan?: Date;
}

export interface PurgeTableOptions {
  /** Brand ownership of a table without brand_id: the column pointing at a brand-owned parent row's id. */
  brandVia?: { column: MySqlColumn; parent: MySqlTable };
  /** The column a brand deletion matches instead of brand_id (the brands table itself: its id). */
  brandColumn?: MySqlColumn;
  /** The column a retention cut-off (`olderThan`) applies to; created_at by default. */
  timeColumn?: MySqlColumn;
}

const column = (table: MySqlTable, name: string): MySqlColumn | undefined =>
  Object.values(getTableColumns(table)).find((c) => c.name === name);

/**
 * Spec 17.5 deletion and retention fan-out. Removes (or anonymises) every row of one tenant-scoped table for the
 * current tenant context, optionally narrowed to one brand or to rows older than a cut-off. It is not a feature
 * repository: only the operations module's deletion and retention jobs drive it, through the handlers each module
 * registers at its composition root (`registerDeletionHandler` / `registerRetentionHandler`). Deletes run in
 * bounded batches so a large tenant never becomes one unbounded statement. Insert-only tables (spec 6.1) need the
 * retention database role for DELETE; the application role is refused by the engine (docs/operations).
 */
export class TenantPurgeRepository {
  private readonly tenantCol: MySqlColumn;
  private readonly brandCol: MySqlColumn | undefined;
  private readonly timeCol: MySqlColumn | undefined;

  constructor(
    readonly table: MySqlTable,
    private readonly opts: PurgeTableOptions = {},
  ) {
    const tenantCol = column(table, 'tenant_id');
    if (!tenantCol) throw new Error(`${getTableName(table)} has no tenant_id column; it cannot be purged`);
    this.tenantCol = tenantCol;
    this.brandCol = opts.brandColumn ?? column(table, 'brand_id');
    this.timeCol = opts.timeColumn ?? column(table, 'created_at');
  }

  get name(): string {
    return getTableName(this.table);
  }

  /** True when a brand-scoped purge can reach this table (a brand_id column or a brand-owned parent). */
  get brandOwned(): boolean {
    return Boolean(this.brandCol || this.opts.brandVia);
  }

  private where(scope: PurgeScope): SQL | null {
    const { tenantId } = requireTenant();
    const clauses: SQL[] = [eq(this.tenantCol, tenantId)];
    if (scope.brandId !== undefined) {
      if (this.brandCol) clauses.push(eq(this.brandCol, scope.brandId));
      else if (this.opts.brandVia) {
        const parent = this.opts.brandVia.parent;
        const parentId = column(parent, 'id');
        const parentTenant = column(parent, 'tenant_id');
        const parentBrand = column(parent, 'brand_id');
        if (!parentId || !parentTenant || !parentBrand)
          throw new Error(`${getTableName(parent)} is not a brand-owned parent of ${this.name}`);
        clauses.push(
          inArray(
            this.opts.brandVia.column,
            getDb()
              .select({ id: parentId })
              .from(parent)
              .where(and(eq(parentTenant, tenantId), eq(parentBrand, scope.brandId))),
          ),
        );
      } else return null; // a tenant-level table: a brand deletion does not reach it
    }
    if (scope.olderThan) {
      if (!this.timeCol) throw new Error(`${this.name} has no time column for a retention cut-off`);
      clauses.push(lt(this.timeCol, scope.olderThan));
    }
    return and(...clauses) as SQL;
  }

  async count(scope: PurgeScope, tx?: Tx): Promise<number> {
    const where = this.where(scope);
    if (!where) return 0;
    const rows = await (tx ?? getDb())
      .select({ c: sql<number>`count(*)` })
      .from(this.table)
      .where(where);
    return Number(rows[0]?.c ?? 0);
  }

  /** Distinct non-empty values of one column in scope (e.g. object storage keys to delete before the rows). */
  async values(of: MySqlColumn, scope: PurgeScope, tx?: Tx): Promise<string[]> {
    const where = this.where(scope);
    if (!where) return [];
    const rows = await (tx ?? getDb()).selectDistinct({ v: of }).from(this.table).where(where);
    return rows.map((r) => r.v).filter((v): v is string => typeof v === 'string' && v.length > 0);
  }

  /** Deletes every row in scope in batches; returns the number of rows removed (0 on a repeat). */
  async purge(scope: PurgeScope, tx?: Tx, batchSize = 1000): Promise<number> {
    const where = this.where(scope);
    if (!where) return 0;
    let total = 0;
    for (;;) {
      const removed = affectedRows(await (tx ?? getDb()).delete(this.table).where(where).limit(batchSize));
      total += removed;
      if (removed < batchSize) return total;
    }
  }

  /** Overwrites the given columns on every row in scope (personal data replaced, the row kept as a tombstone). */
  async anonymise(values: Record<string, unknown>, scope: PurgeScope, tx?: Tx): Promise<number> {
    const where = this.where(scope);
    if (!where) return 0;
    return affectedRows(
      await (tx ?? getDb())
        .update(this.table)
        .set(values as never)
        .where(where),
    );
  }
}

/**
 * The tables of a schema module (e.g. `import * as publishing from '@oremedia/db/schema/publishing'`) that carry a
 * tenant_id column: the same detection as tooling/scripts/check-schema-tenancy.ts. Without an argument, the whole
 * schema.
 */
export function tenantScopedTables(module: Record<string, unknown> = schema): MySqlTable[] {
  return Object.values(module)
    .filter((v): v is MySqlTable => v instanceof MySqlTable)
    .filter((t) => column(t, 'tenant_id') !== undefined);
}

/** Orders tables so a table comes before every table its foreign keys reference (children are purged first). */
export function purgeOrder(tables: readonly MySqlTable[]): MySqlTable[] {
  const set = new Set(tables);
  const ordered: MySqlTable[] = [];
  const visiting = new Set<MySqlTable>();
  const done = new Set<MySqlTable>();
  // Depth-first on "is referenced by": a table is emitted after every table in the set that references it.
  const referencedBy = new Map<MySqlTable, MySqlTable[]>();
  for (const t of tables)
    for (const fk of getTableConfig(t).foreignKeys) {
      const parent = fk.reference().foreignTable as MySqlTable;
      if (parent === t || !set.has(parent)) continue;
      referencedBy.set(parent, [...(referencedBy.get(parent) ?? []), t]);
    }
  const visit = (t: MySqlTable) => {
    if (done.has(t)) return;
    if (visiting.has(t)) throw new Error(`foreign key cycle through ${getTableName(t)}`);
    visiting.add(t);
    for (const child of referencedBy.get(t) ?? []) visit(child);
    visiting.delete(t);
    done.add(t);
    ordered.push(t);
  };
  for (const t of tables) visit(t);
  // visit() emits a parent after its children were emitted, so `ordered` is already children-first.
  return ordered;
}
