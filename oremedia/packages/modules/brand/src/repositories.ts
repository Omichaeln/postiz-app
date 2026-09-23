import { inArray } from 'drizzle-orm';
import { BrandScopedRepository, TenantScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import { brands } from '@oremedia/db/schema/brand';

/** Brands themselves are tenant-owned; visibility narrows to ctx.brandIds. */
export class BrandRepository extends TenantScopedRepository<typeof brands> {
  constructor() {
    super(brands);
  }
  /** Rows visible to the actor: all in the tenant, or only the granted brands. */
  async listVisible(tx?: Tx) {
    const ctx = requireTenant();
    if (ctx.brandIds === 'all') return this.conn(tx).select().from(brands).where(this.scope());
    if (ctx.brandIds.size === 0) return [];
    return this.conn(tx)
      .select()
      .from(brands)
      .where(this.scope(inArray(brands.id, [...ctx.brandIds])));
  }
  override async findById(id: string, tx?: Tx) {
    const row = await super.findById(id, tx);
    if (!row) return null;
    const ctx = requireTenant();
    if (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.id)) return null;
    return row;
  }
  async create(values: Omit<typeof brands.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof brands.$inferInsert>, tx?: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async countAll(tx?: Tx): Promise<number> {
    const rows = await this.conn(tx).select({ id: brands.id }).from(brands).where(this.scope());
    return rows.length;
  }
  /** Ids from the input that do not exist in this tenant (used to validate grants and subjects). */
  async missing(ids: string[], tx?: Tx): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.conn(tx)
      .select({ id: brands.id })
      .from(brands)
      .where(this.scope(inArray(brands.id, ids)));
    const found = new Set(rows.map((r) => r.id));
    return ids.filter((i) => !found.has(i));
  }
}

export { BrandScopedRepository };
