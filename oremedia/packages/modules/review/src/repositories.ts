import { and, asc, desc, eq, inArray, lte, type SQL } from 'drizzle-orm';
import type { ApprovalState } from '@oremedia/contracts/approval';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import type { ReviewRequestState } from '@oremedia/contracts/review';
import { BrandScopedRepository, type Tx } from '@oremedia/db';
import {
  publishingMandates,
  releaseApprovals,
  reviewDecisions,
  reviewRequests,
} from '@oremedia/db/schema/review';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

const INBOX_STATES: readonly ReviewRequestState[] = ['open', 'stale', 'decided'];

export class ReviewRequestRepository extends BrandScopedRepository<typeof reviewRequests> {
  constructor() {
    super(reviewRequests);
  }
  async create(values: Omit<typeof reviewRequests.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof reviewRequests.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async listForRevision(brandId: string, contentRevisionId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(reviewRequests)
      .where(this.brandScope(brandId, eq(reviewRequests.contentRevisionId, contentRevisionId)))
      .orderBy(desc(reviewRequests.id));
  }
  async listOpenForRevision(brandId: string, contentRevisionId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(reviewRequests)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(reviewRequests.contentRevisionId, contentRevisionId),
            eq(reviewRequests.state, 'open'),
          ) as SQL,
        ),
      )
      .orderBy(desc(reviewRequests.id));
  }
  async listOpenForBrand(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(reviewRequests)
      .where(this.brandScope(brandId, eq(reviewRequests.state, 'open')))
      .orderBy(desc(reviewRequests.id))
      .limit(200);
  }
  /**
   * Spec 21.2 review inbox: open, stale and decided requests of the brands the actor may see, newest first.
   * `brandIds: 'all'` is the tenant-wide view (the tenant scope still applies).
   */
  async listInbox(
    brandIds: 'all' | readonly string[],
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof reviewRequests.$inferSelect>> {
    if (brandIds !== 'all' && brandIds.length === 0) return { items: [], nextCursor: null };
    const clauses: SQL[] = [inArray(reviewRequests.state, [...INBOX_STATES])];
    if (brandIds !== 'all') clauses.push(inArray(reviewRequests.brandId, [...brandIds]));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(reviewRequests.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(reviewRequests)
      .where(this.scope(and(...clauses) as SQL))
      .orderBy(desc(reviewRequests.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
}

/** Insert-only (spec 6.1): every decision is evidence. */
export class ReviewDecisionRepository extends BrandScopedRepository<typeof reviewDecisions> {
  constructor() {
    super(reviewDecisions);
  }
  async create(values: Omit<typeof reviewDecisions.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async listForRequest(brandId: string, reviewRequestId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(reviewDecisions)
      .where(this.brandScope(brandId, eq(reviewDecisions.reviewRequestId, reviewRequestId)))
      .orderBy(asc(reviewDecisions.id));
  }
}

/** Append-plus-state (spec 6.1): the binding never changes; only `state` moves, by approvalMachine. */
export class ReleaseApprovalRepository extends BrandScopedRepository<typeof releaseApprovals> {
  constructor() {
    super(releaseApprovals);
  }
  async create(values: Omit<typeof releaseApprovals.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async setState(
    id: string,
    expectedVersion: number,
    state: ApprovalState,
    invalidatedReason: string | null,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, { state, invalidatedReason }, tx);
  }
  async listForRevision(brandId: string, contentRevisionId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(releaseApprovals)
      .where(this.brandScope(brandId, eq(releaseApprovals.contentRevisionId, contentRevisionId)))
      .orderBy(desc(releaseApprovals.id));
  }
  async listValidForRevision(brandId: string, contentRevisionId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(releaseApprovals)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(releaseApprovals.contentRevisionId, contentRevisionId),
            eq(releaseApprovals.state, 'valid'),
          ) as SQL,
        ),
      )
      .orderBy(desc(releaseApprovals.id));
  }
  async listValidForBrand(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(releaseApprovals)
      .where(this.brandScope(brandId, eq(releaseApprovals.state, 'valid')))
      .orderBy(desc(releaseApprovals.id))
      .limit(200);
  }
}

export class PublishingMandateRepository extends BrandScopedRepository<typeof publishingMandates> {
  constructor() {
    super(publishingMandates);
  }
  async create(values: Omit<typeof publishingMandates.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof publishingMandates.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async list(
    brandId: string,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof publishingMandates.$inferSelect>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select()
      .from(publishingMandates)
      .where(this.brandScope(brandId, cursor ? lte(publishingMandates.id, cursor.id) : undefined))
      .orderBy(desc(publishingMandates.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
}
