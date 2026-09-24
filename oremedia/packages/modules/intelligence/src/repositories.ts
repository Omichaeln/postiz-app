import { and, asc, desc, eq, gte, inArray, lt, lte, type SQL } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import { BrandScopedRepository, type Tx } from '@oremedia/db';
import {
  anomalies,
  customerVoiceClusters,
  insights,
  learningRecords,
  playbookEntries,
  recommendations,
} from '@oremedia/db/schema/intelligence';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

type InsightKind = typeof insights.$inferSelect.kind;
type InsightState = typeof insights.$inferSelect.state;
type RecommendationState = typeof recommendations.$inferSelect.state;
type PlaybookState = typeof playbookEntries.$inferSelect.state;
type ClusterKind = typeof customerVoiceClusters.$inferSelect.kind;
type AnomalyState = typeof anomalies.$inferSelect.state;

export class InsightRepository extends BrandScopedRepository<typeof insights> {
  constructor() {
    super(insights);
  }
  async create(values: Omit<typeof insights.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof insights.$inferInsert>, tx: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async list(
    brandId: string,
    filter: { kind?: InsightKind; state: InsightState },
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof insights.$inferSelect>> {
    const clauses: SQL[] = [eq(insights.state, filter.state)];
    if (filter.kind) clauses.push(eq(insights.kind, filter.kind));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(insights.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(insights)
      .where(this.brandScope(brandId, and(...clauses) as SQL))
      .orderBy(desc(insights.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  async listActive(brandId: string, kinds: readonly InsightKind[], tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(insights)
      .where(
        this.brandScope(
          brandId,
          and(eq(insights.state, 'active'), inArray(insights.kind, [...kinds])) as SQL,
        ),
      )
      .orderBy(desc(insights.id))
      .limit(200);
  }
  async listByIds(brandId: string, ids: readonly string[], tx?: Tx) {
    if (ids.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(insights)
      .where(this.brandScope(brandId, inArray(insights.id, [...ids])))
      .orderBy(asc(insights.id));
  }
  /** Insights of the given kinds written for exactly this period (the analyst's retry check, spec 16.3). */
  async listForPeriod(
    brandId: string,
    kinds: readonly InsightKind[],
    periodStart: Date,
    periodEnd: Date,
    tx?: Tx,
  ) {
    return this.conn(tx)
      .select()
      .from(insights)
      .where(
        this.brandScope(
          brandId,
          and(
            inArray(insights.kind, [...kinds]),
            eq(insights.periodStart, periodStart),
            eq(insights.periodEnd, periodEnd),
          ) as SQL,
        ),
      )
      .orderBy(asc(insights.id))
      .limit(200);
  }
  async listForRun(brandId: string, agentRunId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(insights)
      .where(this.brandScope(brandId, eq(insights.agentRunId, agentRunId)))
      .orderBy(asc(insights.id));
  }
}

export class RecommendationRepository extends BrandScopedRepository<typeof recommendations> {
  constructor() {
    super(recommendations);
  }
  async create(values: Omit<typeof recommendations.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof recommendations.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Row lock for accept / dismiss (the decision and its downstream object commit together). */
  async lock(id: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(recommendations)
      .where(this.scope(eq(recommendations.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('Recommendation', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  async list(
    brandId: string,
    state: RecommendationState | undefined,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof recommendations.$inferSelect>> {
    const clauses: SQL[] = [];
    if (state) clauses.push(eq(recommendations.state, state));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(recommendations.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(recommendations)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(recommendations.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** Proposed recommendations in rank order (rank 0 = unranked, listed last by id). */
  async listProposed(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(recommendations)
      .where(this.brandScope(brandId, eq(recommendations.state, 'proposed')))
      .orderBy(asc(recommendations.rank), desc(recommendations.id))
      .limit(200);
  }
  /** Every decided recommendation of the brand: the closed loops a learned ranker may learn from (brand scoped). */
  async listDecided(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(recommendations)
      .where(this.brandScope(brandId, inArray(recommendations.state, ['accepted', 'executed', 'dismissed'])))
      .orderBy(desc(recommendations.id))
      .limit(500);
  }
  /** Recommendations decided before a moment: the history a comparison of a later period may learn from. */
  async listDecidedBefore(brandId: string, before: Date, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(recommendations)
      .where(
        this.brandScope(
          brandId,
          and(
            inArray(recommendations.state, ['accepted', 'executed', 'dismissed']),
            lt(recommendations.updatedAt, before),
          ) as SQL,
        ),
      )
      .orderBy(desc(recommendations.id))
      .limit(500);
  }
  async listDecidedBetween(brandId: string, from: Date, to: Date, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(recommendations)
      .where(
        this.brandScope(
          brandId,
          and(
            inArray(recommendations.state, ['accepted', 'executed', 'dismissed']),
            gte(recommendations.updatedAt, from),
            lte(recommendations.updatedAt, to),
          ) as SQL,
        ),
      )
      .orderBy(asc(recommendations.id))
      .limit(500);
  }
}

export class LearningRecordRepository extends BrandScopedRepository<typeof learningRecords> {
  constructor() {
    super(learningRecords);
  }
  async create(values: Omit<typeof learningRecords.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof learningRecords.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async findForRecommendation(brandId: string, recommendationId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(learningRecords)
      .where(this.brandScope(brandId, eq(learningRecords.recommendationId, recommendationId)))
      .limit(1);
    return rows[0] ?? null;
  }
  async listForRecommendations(brandId: string, recommendationIds: readonly string[], tx?: Tx) {
    if (recommendationIds.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(learningRecords)
      .where(this.brandScope(brandId, inArray(learningRecords.recommendationId, [...recommendationIds])));
  }
  /** Every record of the brand with a verdict: the history a learned ranker is allowed to see (spec 16.8 isolation). */
  async listWithVerdict(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(learningRecords)
      .where(
        this.brandScope(
          brandId,
          inArray(learningRecords.verdict, ['supported', 'not_supported', 'inconclusive']),
        ),
      )
      .orderBy(desc(learningRecords.id))
      .limit(500);
  }
}

export class PlaybookEntryRepository extends BrandScopedRepository<typeof playbookEntries> {
  constructor() {
    super(playbookEntries);
  }
  async create(values: Omit<typeof playbookEntries.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof playbookEntries.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async list(
    brandId: string,
    state: PlaybookState | undefined,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof playbookEntries.$inferSelect>> {
    const clauses: SQL[] = [];
    if (state) clauses.push(eq(playbookEntries.state, state));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(playbookEntries.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(playbookEntries)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(playbookEntries.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  async listApproved(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(playbookEntries)
      .where(this.brandScope(brandId, eq(playbookEntries.state, 'approved')))
      .orderBy(desc(playbookEntries.id))
      .limit(200);
  }
}

export class CustomerVoiceClusterRepository extends BrandScopedRepository<typeof customerVoiceClusters> {
  constructor() {
    super(customerVoiceClusters);
  }
  async create(values: Omit<typeof customerVoiceClusters.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof customerVoiceClusters.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** The brand's clusters of one kind (the candidate set for incremental clustering); the brand scope is the isolation. */
  async listForBrand(brandId: string, kind: ClusterKind | undefined, limit: number, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(customerVoiceClusters)
      .where(this.brandScope(brandId, kind ? eq(customerVoiceClusters.kind, kind) : undefined))
      .orderBy(desc(customerVoiceClusters.size), desc(customerVoiceClusters.id))
      .limit(limit);
  }
  /** Row locks for the incremental update (two comments must not split one cluster). */
  async lockForBrand(brandId: string, kind: ClusterKind, tx: Tx) {
    return this.conn(tx)
      .select()
      .from(customerVoiceClusters)
      .where(this.brandScope(brandId, eq(customerVoiceClusters.kind, kind)))
      .orderBy(asc(customerVoiceClusters.id))
      .limit(500)
      .for('update');
  }
}

export class AnomalyRepository extends BrandScopedRepository<typeof anomalies> {
  constructor() {
    super(anomalies);
  }
  async create(values: Omit<typeof anomalies.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async list(
    brandId: string,
    state: AnomalyState | undefined,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof anomalies.$inferSelect>> {
    const clauses: SQL[] = [];
    if (state) clauses.push(eq(anomalies.state, state));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(anomalies.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(anomalies)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(anomalies.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
}
