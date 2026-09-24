import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { ContentRevisionState } from '@oremedia/contracts/review';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import { BrandScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import {
  briefs,
  campaigns,
  channelVariants,
  contentPackages,
  contentRevisions,
  creativeAttributes,
} from '@oremedia/db/schema/content';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

export class CampaignRepository extends BrandScopedRepository<typeof campaigns> {
  constructor() {
    super(campaigns);
  }
  async create(values: Omit<typeof campaigns.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof campaigns.$inferInsert>, tx: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async list(brandId: string, page: PageRequest, tx?: Tx): Promise<Page<typeof campaigns.$inferSelect>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select()
      .from(campaigns)
      .where(this.brandScope(brandId, cursor ? lte(campaigns.id, cursor.id) : undefined))
      .orderBy(desc(campaigns.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** Campaigns whose run overlaps [from, to] (calendar.range). */
  async listOverlapping(brandId: string, from: Date, to: Date, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(campaigns)
      .where(this.brandScope(brandId, and(lte(campaigns.startsAt, to), gte(campaigns.endsAt, from)) as SQL))
      .orderBy(asc(campaigns.startsAt))
      .limit(200);
  }
}

export class BriefRepository extends BrandScopedRepository<typeof briefs> {
  constructor() {
    super(briefs);
  }
  async create(values: Omit<typeof briefs.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof briefs.$inferInsert>, tx: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async list(
    brandId: string,
    campaignId: string | undefined,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof briefs.$inferSelect>> {
    const clauses: SQL[] = [];
    if (campaignId) clauses.push(eq(briefs.campaignId, campaignId));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(briefs.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(briefs)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(briefs.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
}

export class ContentPackageRepository extends BrandScopedRepository<typeof contentPackages> {
  constructor() {
    super(contentPackages);
  }
  /** Row lock (SELECT ... FOR UPDATE, as creative documents lock): revising serialises on the package. Same visibility as findById. */
  async lock(id: string, tx: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(contentPackages)
      .where(this.scope(eq(contentPackages.id, id)))
      .for('update');
    const row = rows[0];
    const ctx = requireTenant();
    if (!row || (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.brandId)))
      throw new NotFoundError('ContentPackage', id);
    return row;
  }
  async create(values: Omit<typeof contentPackages.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof contentPackages.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Newest first on the (tenant_id, brand_id, id) unique index (spec 7.4). */
  async list(
    brandId: string,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof contentPackages.$inferSelect>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.conn(tx)
      .select()
      .from(contentPackages)
      .where(this.brandScope(brandId, cursor ? lte(contentPackages.id, cursor.id) : undefined))
      .orderBy(desc(contentPackages.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** Packages touched in [from, to] (calendar.range fallback when no publishing source is registered). */
  async listUpdatedBetween(brandId: string, from: Date, to: Date, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(contentPackages)
      .where(
        this.brandScope(
          brandId,
          and(gte(contentPackages.updatedAt, from), lte(contentPackages.updatedAt, to)) as SQL,
        ),
      )
      .orderBy(desc(contentPackages.updatedAt))
      .limit(200);
  }
}

/**
 * Append-plus-state (spec 6.1): a revision's content never changes after insert; only `state` moves, by
 * contentRevisionMachine, through setState.
 */
export class ContentRevisionRepository extends BrandScopedRepository<typeof contentRevisions> {
  constructor() {
    super(contentRevisions);
  }
  async create(values: Omit<typeof contentRevisions.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async setState(id: string, expectedVersion: number, state: ContentRevisionState, tx: Tx) {
    await this.updateScoped(id, expectedVersion, { state }, tx);
  }
  /** Next revision number; callers hold the package row lock so two revisions never race for the same number. */
  async nextNumber(brandId: string, packageId: string, tx: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ max: sql<number>`coalesce(max(${contentRevisions.number}), 0)` })
      .from(contentRevisions)
      .where(this.brandScope(brandId, eq(contentRevisions.packageId, packageId)));
    return Number(rows[0]?.max ?? 0) + 1;
  }
  async listForPackage(brandId: string, packageId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(contentRevisions)
      .where(this.brandScope(brandId, eq(contentRevisions.packageId, packageId)))
      .orderBy(desc(contentRevisions.number))
      .limit(200);
  }
  /** Revisions of a brand in the given states (those that can carry an open request or a valid approval). */
  async listInStates(brandId: string, states: readonly ContentRevisionState[], tx?: Tx) {
    if (states.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(contentRevisions)
      .where(this.brandScope(brandId, inArray(contentRevisions.state, [...states])))
      .orderBy(desc(contentRevisions.id))
      .limit(200);
  }
}

export class ChannelVariantRepository extends BrandScopedRepository<typeof channelVariants> {
  constructor() {
    super(channelVariants);
  }
  async create(values: Omit<typeof channelVariants.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof channelVariants.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Every variant of a revision, in a stable order (channel connection id) so bindings hash deterministically. */
  async listForRevision(brandId: string, contentRevisionId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(channelVariants)
      .where(this.brandScope(brandId, eq(channelVariants.contentRevisionId, contentRevisionId)))
      .orderBy(asc(channelVariants.channelConnectionId))
      .limit(200);
  }
}

/** Spec 16.2: one attributes row per content revision (or channel variant); corrections bump the version. */
export class CreativeAttributeRepository extends BrandScopedRepository<typeof creativeAttributes> {
  constructor() {
    super(creativeAttributes);
  }
  async create(values: Omit<typeof creativeAttributes.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof creativeAttributes.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async findForRevision(contentRevisionId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(creativeAttributes)
      .where(this.scope(eq(creativeAttributes.contentRevisionId, contentRevisionId)))
      .orderBy(desc(creativeAttributes.id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const ctx = requireTenant();
    if (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.brandId)) return null;
    return row;
  }
  async findForVariant(channelVariantId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(creativeAttributes)
      .where(this.scope(eq(creativeAttributes.channelVariantId, channelVariantId)))
      .orderBy(desc(creativeAttributes.id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const ctx = requireTenant();
    if (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.brandId)) return null;
    return row;
  }
}
