import { and, asc, desc, eq, lte, type SQL } from 'drizzle-orm';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import { BrandScopedRepository, type Tx } from '@oremedia/db';
import {
  experimentAssignments,
  experimentResults,
  experimentVariants,
  experiments,
} from '@oremedia/db/schema/experiments';
import { NotFoundError } from '@oremedia/contracts/errors';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

export class ExperimentRepository extends BrandScopedRepository<typeof experiments> {
  constructor() {
    super(experiments);
  }
  async create(values: Omit<typeof experiments.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof experiments.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Row lock for the state transitions (pre-register, start, stop, analyse) and for assignments. */
  async lock(id: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(experiments)
      .where(this.scope(eq(experiments.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('Experiment', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  async list(
    brandId: string,
    state: string | undefined,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof experiments.$inferSelect>> {
    const clauses: SQL[] = [];
    if (state) clauses.push(eq(experiments.state, state as typeof experiments.$inferSelect.state));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(experiments.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(experiments)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(experiments.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  async listForBrand(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(experiments)
      .where(this.brandScope(brandId))
      .orderBy(desc(experiments.id))
      .limit(200);
  }
  async listForRecommendation(brandId: string, recommendationId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(experiments)
      .where(this.brandScope(brandId, eq(experiments.recommendationId, recommendationId)))
      .orderBy(desc(experiments.id));
  }
}

export class ExperimentVariantRepository extends BrandScopedRepository<typeof experimentVariants> {
  constructor() {
    super(experimentVariants);
  }
  async create(values: Omit<typeof experimentVariants.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  /** In insertion order (ULIDs): the first variant is the control (spec 16.6 analysis). */
  async listForExperiment(brandId: string, experimentId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(experimentVariants)
      .where(this.brandScope(brandId, eq(experimentVariants.experimentId, experimentId)))
      .orderBy(asc(experimentVariants.id));
  }
}

/** Insert-only (spec 6.1): an assignment never changes. */
export class ExperimentAssignmentRepository extends BrandScopedRepository<typeof experimentAssignments> {
  constructor() {
    super(experimentAssignments);
  }
  async create(values: Omit<typeof experimentAssignments.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async find(brandId: string, experimentId: string, unitType: string, unitIdHash: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(experimentAssignments)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(experimentAssignments.experimentId, experimentId),
            eq(experimentAssignments.unitType, unitType as 'visitor' | 'publication_slot'),
            eq(experimentAssignments.unitIdHash, unitIdHash),
          ) as SQL,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  async countForExperiment(brandId: string, experimentId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select({ variantId: experimentAssignments.variantId })
      .from(experimentAssignments)
      .where(this.brandScope(brandId, eq(experimentAssignments.experimentId, experimentId)));
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.variantId, (counts.get(r.variantId) ?? 0) + 1);
    return counts;
  }
}

/** Insert-only (spec 6.1): every computed result is evidence, newest first. */
export class ExperimentResultRepository extends BrandScopedRepository<typeof experimentResults> {
  constructor() {
    super(experimentResults);
  }
  async create(values: Omit<typeof experimentResults.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async listForExperiment(brandId: string, experimentId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(experimentResults)
      .where(this.brandScope(brandId, eq(experimentResults.experimentId, experimentId)))
      .orderBy(desc(experimentResults.id));
  }
}
