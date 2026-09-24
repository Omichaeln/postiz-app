import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { FactState } from '@oremedia/contracts/brand';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import { BrandScopedRepository, TenantScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import {
  approvedFacts,
  brandObjectives,
  brandVersions,
  brands,
  designTokens,
  policyVersions,
} from '@oremedia/db/schema/brand';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

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
  /**
   * Parent-row lock (SELECT ... FOR UPDATE, as budgets lock spend_limits): serialises version-number allocation
   * and the "exactly one published / active" switches for one brand. Same visibility rule as findById.
   */
  async lock(id: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(brands)
      .where(this.scope(eq(brands.id, id)))
      .for('update');
    const row = rows[0];
    const ctx = requireTenant();
    if (!row || (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.id))) throw new NotFoundError('Brand', id);
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

export class BrandVersionRepository extends BrandScopedRepository<typeof brandVersions> {
  constructor() {
    super(brandVersions);
  }
  async create(values: Omit<typeof brandVersions.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof brandVersions.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Spec 8.2: exactly one published version per brand. */
  async findPublished(brandId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(brandVersions)
      .where(this.brandScope(brandId, eq(brandVersions.state, 'published')))
      .limit(1);
    return rows[0] ?? null;
  }
  /** Next version number; callers hold the brand row lock so two drafts never race for the same number. */
  async nextNumber(brandId: string, tx: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ max: sql<number>`coalesce(max(${brandVersions.number}), 0)` })
      .from(brandVersions)
      .where(this.brandScope(brandId));
    return Number(rows[0]?.max ?? 0) + 1;
  }
  async list(brandId: string, page: PageRequest, tx?: Tx): Promise<Page<typeof brandVersions.$inferSelect>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select()
      .from(brandVersions)
      .where(this.brandScope(brandId, cursor ? lte(brandVersions.id, cursor.id) : undefined))
      .orderBy(desc(brandVersions.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
}

/** Written once per published version (spec 6.3 design_tokens); no update method by design. */
export class DesignTokenRepository extends BrandScopedRepository<typeof designTokens> {
  constructor() {
    super(designTokens);
  }
  async create(values: Omit<typeof designTokens.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async findForVersion(brandId: string, brandVersionId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(designTokens)
      .where(this.brandScope(brandId, eq(designTokens.brandVersionId, brandVersionId)))
      .limit(1);
    return rows[0] ?? null;
  }
}

export class ApprovedFactRepository extends BrandScopedRepository<typeof approvedFacts> {
  constructor() {
    super(approvedFacts);
  }
  async create(values: Omit<typeof approvedFacts.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof approvedFacts.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async list(
    brandId: string,
    state: FactState | undefined,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof approvedFacts.$inferSelect>> {
    const clauses: SQL[] = [];
    if (state) clauses.push(eq(approvedFacts.state, state));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(approvedFacts.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(approvedFacts)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(approvedFacts.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** Spec 8.3 "approved non-expired": approved and with a validity window containing `at`, ordered by id. */
  async listEffective(brandId: string, at: Date, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(approvedFacts)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(approvedFacts.state, 'approved'),
            or(isNull(approvedFacts.validFrom), lte(approvedFacts.validFrom, at)),
            or(isNull(approvedFacts.validUntil), gt(approvedFacts.validUntil, at)),
          ) as SQL,
        ),
      )
      .orderBy(asc(approvedFacts.id));
  }
}

export class BrandObjectiveRepository extends BrandScopedRepository<typeof brandObjectives> {
  constructor() {
    super(brandObjectives);
  }
  async create(values: Omit<typeof brandObjectives.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof brandObjectives.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  private activeAt(at: Date): SQL {
    return and(
      lte(brandObjectives.activeFrom, at),
      or(isNull(brandObjectives.activeUntil), gt(brandObjectives.activeUntil, at)),
    ) as SQL;
  }
  async list(
    brandId: string,
    activeOnly: boolean,
    at: Date,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof brandObjectives.$inferSelect>> {
    const clauses: SQL[] = [];
    if (activeOnly) clauses.push(this.activeAt(at));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(brandObjectives.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(brandObjectives)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(brandObjectives.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** Objectives active at `at` (spec 8.3), ordered by id. */
  async listActive(brandId: string, at: Date, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(brandObjectives)
      .where(this.brandScope(brandId, this.activeAt(at)))
      .orderBy(asc(brandObjectives.id));
  }
  /** Objectives still open at `at` (no end, or an end after `at`): the ones a new objective closes. */
  async listOpenAt(brandId: string, at: Date, tx: Tx) {
    return this.conn(tx)
      .select()
      .from(brandObjectives)
      .where(
        this.brandScope(
          brandId,
          or(isNull(brandObjectives.activeUntil), gt(brandObjectives.activeUntil, at)) as SQL,
        ),
      )
      .orderBy(asc(brandObjectives.id));
  }
}

export class PolicyVersionRepository extends BrandScopedRepository<typeof policyVersions> {
  constructor() {
    super(policyVersions);
  }
  async create(values: Omit<typeof policyVersions.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof policyVersions.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Exactly one active policy version per brand (activation retires the previous). */
  async findActive(brandId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(policyVersions)
      .where(this.brandScope(brandId, eq(policyVersions.state, 'active')))
      .limit(1);
    return rows[0] ?? null;
  }
  /** Next policy number; callers hold the brand row lock. */
  async nextNumber(brandId: string, tx: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ max: sql<number>`coalesce(max(${policyVersions.number}), 0)` })
      .from(policyVersions)
      .where(this.brandScope(brandId));
    return Number(rows[0]?.max ?? 0) + 1;
  }
}

export { BrandScopedRepository };
