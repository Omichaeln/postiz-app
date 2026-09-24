import { and, asc, desc, eq, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { MySqlColumn, MySqlTable } from 'drizzle-orm/mysql-core';
import { ConflictError, NotFoundError } from '@oremedia/contracts/errors';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import type { EvaluationCase, SkillScope } from '@oremedia/contracts/skills';
import {
  PlatformRepository,
  TenantScopedRepository,
  affectedRows,
  requireTenant,
  type Tx,
} from '@oremedia/db';
import {
  evaluationResults,
  evaluationSuites,
  skillBindings,
  skillVersions,
  skills,
} from '@oremedia/db/schema/skills';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/**
 * skill_bindings.brand_id is NOT NULL: a tenant-wide binding (scope 'tenant') is stored under this sentinel, which
 * is never a brand id. Platform-scope bindings are skills.active_version_id of the platform skill.
 */
export const TENANT_WIDE_BRAND = '*';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

type GlobalPlusTenantTable = MySqlTable & { tenantId: MySqlColumn; id: MySqlColumn };

/**
 * GLOBAL_PLUS_TENANT_TABLES (skills, skill_versions, evaluation_suites, evaluation_results): platform rows have
 * tenant_id NULL and are readable by every tenant, so reads use `(tenant_id = ctx OR tenant_id IS NULL)`. Writes keep
 * the base tenant scope: a tenant user can never insert or update a platform row through these repositories.
 * Platform rows are written only by PlatformSkillRepository under runAsPlatform.
 */
abstract class GlobalPlusTenantRepository<T extends GlobalPlusTenantTable> extends TenantScopedRepository<T> {
  protected readScope(extra?: SQL): SQL {
    const { tenantId } = requireTenant();
    const visible = or(eq(this.table.tenantId, tenantId), isNull(this.table.tenantId)) as SQL;
    return extra ? (and(visible, extra) as SQL) : visible;
  }
  override async findById(id: string, tx?: Tx): Promise<T['$inferSelect'] | null> {
    const rows = await this.conn(tx)
      .select()
      .from(this.table as MySqlTable)
      .where(this.readScope(eq(this.table.id, id)))
      .limit(1);
    return (rows[0] as T['$inferSelect'] | undefined) ?? null;
  }
}

export class SkillRepository extends GlobalPlusTenantRepository<typeof skills> {
  constructor() {
    super(skills);
  }
  /** Brand-scoped skills are visible only for brands the actor may see (same rule as BrandScopedRepository). */
  private visibleToActor(row: typeof skills.$inferSelect): boolean {
    if (row.scope !== 'brand' || !row.brandId) return true;
    const ctx = requireTenant();
    return ctx.brandIds === 'all' || ctx.brandIds.has(row.brandId);
  }
  override async findById(id: string, tx?: Tx) {
    const row = await super.findById(id, tx);
    if (!row || !this.visibleToActor(row)) return null;
    return row;
  }
  /** The skill with this key in a scope: platform keys are global, tenant and brand keys belong to the tenant. */
  async findByKey(scope: SkillScope, brandId: string | null, key: string, tx?: Tx) {
    const { tenantId } = requireTenant();
    const rows = await this.conn(tx)
      .select()
      .from(skills)
      .where(
        this.readScope(
          and(
            eq(skills.scope, scope),
            eq(skills.key, key),
            brandId ? eq(skills.brandId, brandId) : isNull(skills.brandId),
            scope === 'platform' ? isNull(skills.tenantId) : eq(skills.tenantId, tenantId),
          ) as SQL,
        ),
      )
      .limit(1);
    const row = rows[0];
    return row && this.visibleToActor(row) ? row : null;
  }
  /** Parent-row lock (SELECT ... FOR UPDATE) for version-number allocation on a tenant-owned skill. */
  async lock(id: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(skills)
      .where(this.scope(eq(skills.id, id)))
      .for('update');
    const row = rows[0];
    if (!row || !this.visibleToActor(row)) throw new NotFoundError('Skill', id);
    return row;
  }
  async create(values: Omit<typeof skills.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof skills.$inferInsert>, tx?: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async list(
    filter: { scope?: SkillScope; brandId?: string },
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof skills.$inferSelect>> {
    const ctx = requireTenant();
    const clauses: SQL[] = [];
    if (filter.scope) clauses.push(eq(skills.scope, filter.scope));
    if (filter.brandId) clauses.push(eq(skills.brandId, filter.brandId));
    else if (ctx.brandIds !== 'all')
      clauses.push(
        ctx.brandIds.size
          ? (or(isNull(skills.brandId), inArray(skills.brandId, [...ctx.brandIds])) as SQL)
          : isNull(skills.brandId),
      );
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(skills.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(skills)
      .where(this.readScope(clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(skills.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** Active skills a run on `brandId` may use: platform, tenant-wide and that brand's own, ordered by key. */
  async listActiveForBrand(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(skills)
      .where(
        this.readScope(
          and(eq(skills.state, 'active'), or(isNull(skills.brandId), eq(skills.brandId, brandId))) as SQL,
        ),
      )
      .orderBy(asc(skills.key), asc(skills.id));
  }
}

/** Version content (manifest, instructions, references, package hash) is written once; only state, rollout and publishedAt move. */
export class SkillVersionRepository extends GlobalPlusTenantRepository<typeof skillVersions> {
  constructor() {
    super(skillVersions);
  }
  async create(values: Omit<typeof skillVersions.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Pick<Partial<typeof skillVersions.$inferInsert>, 'state' | 'rolloutPercent' | 'publishedAt'>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Next version number; callers hold the skill row lock. */
  async nextNumber(skillId: string, tx: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ max: sql<number>`coalesce(max(${skillVersions.number}), 0)` })
      .from(skillVersions)
      .where(this.readScope(eq(skillVersions.skillId, skillId)));
    return Number(rows[0]?.max ?? 0) + 1;
  }
  async listForSkill(skillId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(skillVersions)
      .where(this.readScope(eq(skillVersions.skillId, skillId)))
      .orderBy(desc(skillVersions.number));
  }
  async findMany(ids: string[], tx?: Tx) {
    if (ids.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(skillVersions)
      .where(this.readScope(inArray(skillVersions.id, ids)));
  }
}

export class EvaluationSuiteRepository extends GlobalPlusTenantRepository<typeof evaluationSuites> {
  constructor() {
    super(evaluationSuites);
  }
  async create(values: { id: string; skillVersionId: string; cases: EvaluationCase[] }, tx?: Tx) {
    await this.insertScoped(
      // The column's $type predates the EvaluationCase contract; cases are validated with EvaluationCase on write and read.
      { id: values.id, skillVersionId: values.skillVersionId, cases: values.cases as never },
      tx,
    );
  }
  async findLatestForVersion(skillVersionId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(evaluationSuites)
      .where(this.readScope(eq(evaluationSuites.skillVersionId, skillVersionId)))
      .orderBy(desc(evaluationSuites.id))
      .limit(1);
    return rows[0] ?? null;
  }
}

/** Insert-only (spec 6.1): no update method by design. */
export class EvaluationResultRepository extends GlobalPlusTenantRepository<typeof evaluationResults> {
  constructor() {
    super(evaluationResults);
  }
  async create(values: Omit<typeof evaluationResults.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async findLatestForVersion(skillVersionId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(evaluationResults)
      .where(this.readScope(eq(evaluationResults.skillVersionId, skillVersionId)))
      .orderBy(desc(evaluationResults.id))
      .limit(1);
    return rows[0] ?? null;
  }
  async listForVersions(skillVersionIds: string[], tx?: Tx) {
    if (skillVersionIds.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(evaluationResults)
      .where(this.readScope(inArray(evaluationResults.skillVersionId, skillVersionIds)))
      .orderBy(desc(evaluationResults.id))
      .limit(50);
  }
}

/** Tenant-owned overrides at brand scope (brand_id) or tenant scope (TENANT_WIDE_BRAND), for any visible skill. */
export class SkillBindingRepository extends TenantScopedRepository<typeof skillBindings> {
  constructor() {
    super(skillBindings);
  }
  /** Mirrors BrandScopedRepository.assertBrandAccess; the tenant-wide sentinel is not a brand. */
  private assertBrandKeyAccess(brandKey: string): void {
    if (brandKey === TENANT_WIDE_BRAND) return;
    const ctx = requireTenant();
    if (ctx.brandIds !== 'all' && !ctx.brandIds.has(brandKey)) throw new NotFoundError('Brand', brandKey);
  }
  async create(values: Omit<typeof skillBindings.$inferInsert, 'tenantId'> & { brandId: string }, tx?: Tx) {
    this.assertBrandKeyAccess(values.brandId);
    await this.insertScoped(values, tx);
  }
  async remove(id: string, tx?: Tx) {
    return this.deleteScoped(id, tx);
  }
  async listFor(brandKey: string, taskKind: string, tx?: Tx) {
    this.assertBrandKeyAccess(brandKey);
    return this.conn(tx)
      .select()
      .from(skillBindings)
      .where(this.scope(and(eq(skillBindings.brandId, brandKey), eq(skillBindings.taskKind, taskKind))))
      .orderBy(asc(skillBindings.priority), asc(skillBindings.id));
  }
  async listForVersions(brandKey: string, skillVersionIds: string[], tx?: Tx) {
    this.assertBrandKeyAccess(brandKey);
    if (skillVersionIds.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(skillBindings)
      .where(
        this.scope(
          and(eq(skillBindings.brandId, brandKey), inArray(skillBindings.skillVersionId, skillVersionIds)),
        ),
      )
      .orderBy(asc(skillBindings.id));
  }
  /** Every binding of these versions the actor may see (tenant-wide rows and rows of visible brands). */
  async listVisibleForVersions(skillVersionIds: string[], tx?: Tx) {
    if (skillVersionIds.length === 0) return [];
    const ctx = requireTenant();
    const rows = await this.conn(tx)
      .select()
      .from(skillBindings)
      .where(this.scope(inArray(skillBindings.skillVersionId, skillVersionIds)))
      .orderBy(asc(skillBindings.id));
    return rows.filter(
      (b) => b.brandId === TENANT_WIDE_BRAND || ctx.brandIds === 'all' || ctx.brandIds.has(b.brandId),
    );
  }
}

/**
 * Platform-owned rows (tenant_id NULL): built-in seeding and platform-operator edits. Available only under
 * runAsPlatform (spec 5.3); tenant users read platform rows through the scoped repositories above and never write them.
 */
export class PlatformSkillRepository extends PlatformRepository {
  async findByKey(key: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(skills)
      .where(and(eq(skills.scope, 'platform'), isNull(skills.tenantId), eq(skills.key, key)))
      .limit(1);
    return rows[0] ?? null;
  }
  async lockSkill(id: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(skills)
      .where(and(eq(skills.id, id), isNull(skills.tenantId)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('Skill', id);
    return row;
  }
  async createSkill(values: Omit<typeof skills.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.conn(tx)
      .insert(skills)
      .values({ ...values, tenantId: null, scope: 'platform', brandId: null });
  }
  async updateSkill(
    id: string,
    expectedVersion: number,
    values: Partial<typeof skills.$inferInsert>,
    tx?: Tx,
  ) {
    const res = await this.conn(tx)
      .update(skills)
      .set({ ...values, version: expectedVersion + 1 })
      .where(and(eq(skills.id, id), isNull(skills.tenantId), eq(skills.version, expectedVersion)));
    if (affectedRows(res) !== 1) throw new ConflictError('Skill', id, expectedVersion);
  }
  async nextVersionNumber(skillId: string, tx: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ max: sql<number>`coalesce(max(${skillVersions.number}), 0)` })
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skillId), isNull(skillVersions.tenantId)));
    return Number(rows[0]?.max ?? 0) + 1;
  }
  async createVersion(values: Omit<typeof skillVersions.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.conn(tx)
      .insert(skillVersions)
      .values({ ...values, tenantId: null });
  }
  async updateVersion(
    id: string,
    expectedVersion: number,
    values: Pick<Partial<typeof skillVersions.$inferInsert>, 'state' | 'rolloutPercent' | 'publishedAt'>,
    tx?: Tx,
  ) {
    const res = await this.conn(tx)
      .update(skillVersions)
      .set({ ...values, version: expectedVersion + 1 })
      .where(
        and(
          eq(skillVersions.id, id),
          isNull(skillVersions.tenantId),
          eq(skillVersions.version, expectedVersion),
        ),
      );
    if (affectedRows(res) !== 1) throw new ConflictError('SkillVersion', id, expectedVersion);
  }
  async createSuite(values: { id: string; skillVersionId: string; cases: EvaluationCase[] }, tx?: Tx) {
    await this.conn(tx)
      .insert(evaluationSuites)
      .values({
        id: values.id,
        tenantId: null,
        skillVersionId: values.skillVersionId,
        cases: values.cases as never,
      });
  }
  async createResult(values: Omit<typeof evaluationResults.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.conn(tx)
      .insert(evaluationResults)
      .values({ ...values, tenantId: null });
  }
}
