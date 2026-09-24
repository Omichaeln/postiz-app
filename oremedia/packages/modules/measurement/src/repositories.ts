import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import {
  BrandScopedRepository,
  PlatformRepository,
  TenantScopedRepository,
  requireTenant,
  type Tx,
} from '@oremedia/db';
import { conversations, messages } from '@oremedia/db/schema/community';
import {
  linkClicks,
  metricDefinitions,
  metricSnapshots,
  trackedLinks,
} from '@oremedia/db/schema/measurement';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

/**
 * Global + tenant (GLOBAL_PLUS_TENANT_TABLES): reads see `(tenant_id = ctx OR tenant_id IS NULL)`, every write
 * stamps the tenant. Global rows are seeded by MetricDefinitionSeedRepository under a declared platform job.
 */
export class MetricDefinitionRepository extends TenantScopedRepository<typeof metricDefinitions> {
  constructor() {
    super(metricDefinitions);
  }
  private visible(extra?: SQL): SQL {
    const { tenantId } = requireTenant();
    const clause = or(eq(metricDefinitions.tenantId, tenantId), isNull(metricDefinitions.tenantId)) as SQL;
    return extra ? (and(clause, extra) as SQL) : clause;
  }
  override async findById(id: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(metricDefinitions)
      .where(this.visible(eq(metricDefinitions.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }
  async create(values: Omit<typeof metricDefinitions.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertScoped(values, tx);
  }
  async list(providerKey: string | undefined, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(metricDefinitions)
      .where(this.visible(providerKey ? eq(metricDefinitions.providerKey, providerKey) : undefined))
      .orderBy(asc(metricDefinitions.providerKey), asc(metricDefinitions.key), asc(metricDefinitions.id))
      .limit(500);
  }
  /** The latest definition version of each (key, providerKey) visible to the tenant. */
  async findLatest(key: string, providerKey: string | null, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(metricDefinitions)
      .where(
        this.visible(
          and(
            eq(metricDefinitions.key, key),
            providerKey === null
              ? isNull(metricDefinitions.providerKey)
              : eq(metricDefinitions.providerKey, providerKey),
          ) as SQL,
        ),
      )
      .orderBy(desc(metricDefinitions.definitionVersion))
      .limit(1);
    return rows[0] ?? null;
  }
  async findTenantDefined(key: string, providerKey: string | null, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(metricDefinitions)
      .where(
        this.scope(
          and(
            eq(metricDefinitions.key, key),
            providerKey === null
              ? isNull(metricDefinitions.providerKey)
              : eq(metricDefinitions.providerKey, providerKey),
          ) as SQL,
        ),
      )
      .orderBy(desc(metricDefinitions.definitionVersion))
      .limit(1);
    return rows[0] ?? null;
  }
}

/** Global definitions (tenant_id NULL) are platform rows: seeded from the capability register, never per tenant. */
export class MetricDefinitionSeedRepository extends PlatformRepository {
  async listGlobal(providerKey: string | null) {
    return this.conn()
      .select()
      .from(metricDefinitions)
      .where(
        and(
          isNull(metricDefinitions.tenantId),
          providerKey === null
            ? isNull(metricDefinitions.providerKey)
            : eq(metricDefinitions.providerKey, providerKey),
        ),
      );
  }
  async insertGlobal(values: Array<Omit<typeof metricDefinitions.$inferInsert, 'tenantId'>>) {
    if (values.length === 0) return;
    await this.conn()
      .insert(metricDefinitions)
      .values(values.map((v) => ({ ...v, tenantId: null })));
  }
}

/** Insert-only (spec 6.1, 15.1): unavailable is a row with a null value, never zero. */
export class MetricSnapshotRepository extends BrandScopedRepository<typeof metricSnapshots> {
  constructor() {
    super(metricSnapshots);
  }
  async create(values: Omit<typeof metricSnapshots.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  /** Idempotency per (subject, metric, window): the snapshot ids already written for this window. */
  async findForWindow(
    brandId: string,
    subjectType: (typeof metricSnapshots.$inferSelect)['subjectType'],
    subjectId: string,
    windowStart: Date,
    windowEnd: Date,
    tx?: Tx,
  ) {
    return this.conn(tx)
      .select({ id: metricSnapshots.id, metricKey: metricSnapshots.metricKey })
      .from(metricSnapshots)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(metricSnapshots.subjectType, subjectType),
            eq(metricSnapshots.subjectId, subjectId),
            eq(metricSnapshots.windowStart, windowStart),
            eq(metricSnapshots.windowEnd, windowEnd),
          ) as SQL,
        ),
      );
  }
  /** Distinct metric keys with a snapshot for one subject inside the window. */
  async listKeysForSubject(
    brandId: string,
    subjectType: (typeof metricSnapshots.$inferSelect)['subjectType'],
    subjectId: string,
    windowStart: Date,
    windowEnd: Date,
    tx?: Tx,
  ): Promise<string[]> {
    const rows = await this.conn(tx)
      .selectDistinct({ metricKey: metricSnapshots.metricKey })
      .from(metricSnapshots)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(metricSnapshots.subjectType, subjectType),
            eq(metricSnapshots.subjectId, subjectId),
            gte(metricSnapshots.windowStart, windowStart),
            lte(metricSnapshots.windowEnd, windowEnd),
          ) as SQL,
        ),
      )
      .limit(500);
    return rows.map((r) => r.metricKey);
  }
  /** Snapshots of the subjects and metrics whose window lies inside [windowStart, windowEnd], newest fetch first. */
  async listForQuery(
    brandId: string,
    subjectType: (typeof metricSnapshots.$inferSelect)['subjectType'],
    subjectIds: string[],
    metricKeys: string[],
    windowStart: Date,
    windowEnd: Date,
    tx?: Tx,
  ) {
    if (subjectIds.length === 0 || metricKeys.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(metricSnapshots)
      .where(
        this.brandScope(
          brandId,
          and(
            eq(metricSnapshots.subjectType, subjectType),
            inArray(metricSnapshots.subjectId, subjectIds),
            inArray(metricSnapshots.metricKey, metricKeys),
            gte(metricSnapshots.windowStart, windowStart),
            lte(metricSnapshots.windowEnd, windowEnd),
          ) as SQL,
        ),
      )
      .orderBy(desc(metricSnapshots.fetchedAt), desc(metricSnapshots.id))
      .limit(5000);
  }
}

export class TrackedLinkRepository extends BrandScopedRepository<typeof trackedLinks> {
  constructor() {
    super(trackedLinks);
  }
  async create(values: Omit<typeof trackedLinks.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async findByShortCode(shortCode: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(trackedLinks)
      .where(this.scope(eq(trackedLinks.shortCode, shortCode)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const ctx = requireTenant();
    if (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.brandId)) return null;
    return row;
  }
  async list(
    brandId: string,
    filter: { publicationId?: string; variantId?: string },
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof trackedLinks.$inferSelect>> {
    const clauses: SQL[] = [];
    if (filter.publicationId) clauses.push(eq(trackedLinks.publicationId, filter.publicationId));
    if (filter.variantId) clauses.push(eq(trackedLinks.variantId, filter.variantId));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(trackedLinks.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(trackedLinks)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(trackedLinks.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** Links of a variant that still lack a publication reference (the publication is known only at scheduling). */
  async listForVariant(brandId: string, variantId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(trackedLinks)
      .where(this.brandScope(brandId, eq(trackedLinks.variantId, variantId)))
      .orderBy(asc(trackedLinks.id));
  }
}

/** Insert-only click log; the redirector writes it as a platform job, the module only counts. */
export class LinkClickRepository extends TenantScopedRepository<typeof linkClicks> {
  constructor() {
    super(linkClicks);
  }
  async countByLink(trackedLinkIds: string[], tx?: Tx): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (trackedLinkIds.length === 0) return counts;
    const rows = await this.conn(tx)
      .select({ trackedLinkId: linkClicks.trackedLinkId, c: sql<number>`count(*)` })
      .from(linkClicks)
      .where(this.scope(inArray(linkClicks.trackedLinkId, trackedLinkIds)))
      .groupBy(linkClicks.trackedLinkId);
    for (const r of rows) counts.set(r.trackedLinkId, Number(r.c));
    return counts;
  }
  async countUniqueVisitors(trackedLinkIds: string[], tx?: Tx): Promise<number> {
    if (trackedLinkIds.length === 0) return 0;
    const rows = await this.conn(tx)
      .select({ c: sql<number>`count(distinct ${linkClicks.visitorHash})` })
      .from(linkClicks)
      .where(this.scope(inArray(linkClicks.trackedLinkId, trackedLinkIds)));
    return Number(rows[0]?.c ?? 0);
  }
}

/** One conversation per (channel connection, remote thread); comment ingestion keys threads by remote post id. */
export class ConversationRepository extends BrandScopedRepository<typeof conversations> {
  constructor() {
    super(conversations);
  }
  async create(values: Omit<typeof conversations.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof conversations.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async findByRemoteThread(channelConnectionId: string, remoteThreadId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(conversations)
      .where(
        this.scope(
          and(
            eq(conversations.channelConnectionId, channelConnectionId),
            eq(conversations.remoteThreadId, remoteThreadId),
          ) as SQL,
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const ctx = requireTenant();
    if (ctx.brandIds !== 'all' && !ctx.brandIds.has(row.brandId)) return null;
    return row;
  }
  async listForPublication(brandId: string, publicationId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(conversations)
      .where(this.brandScope(brandId, eq(conversations.publicationId, publicationId)))
      .orderBy(asc(conversations.id));
  }
}

/** Customer voice messages (spec 16.5): author identities are per-tenant salted hashes. */
export class MessageRepository extends BrandScopedRepository<typeof messages> {
  constructor() {
    super(messages);
  }
  async create(values: Omit<typeof messages.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async existsRemote(conversationId: string, remoteMessageId: string, tx?: Tx): Promise<boolean> {
    const rows = await this.conn(tx)
      .select({ id: messages.id })
      .from(messages)
      .where(
        this.scope(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.remoteMessageId, remoteMessageId),
          ) as SQL,
        ),
      )
      .limit(1);
    return rows.length === 1;
  }
  async listForConversations(brandId: string, conversationIds: string[], tx?: Tx) {
    if (conversationIds.length === 0) return [];
    return this.conn(tx)
      .select()
      .from(messages)
      .where(this.brandScope(brandId, inArray(messages.conversationId, conversationIds)))
      .orderBy(asc(messages.remoteCreatedAt), asc(messages.id))
      .limit(5000);
  }
  /** Newest remote timestamp of a conversation: the `since` of the next comment pull. */
  async latestRemoteCreatedAt(conversationId: string, tx?: Tx): Promise<Date | null> {
    const rows = await this.conn(tx)
      .select({ at: sql<Date | string | null>`max(${messages.remoteCreatedAt})` })
      .from(messages)
      .where(this.scope(eq(messages.conversationId, conversationId)));
    const at = rows[0]?.at;
    return at ? new Date(at) : null;
  }
}
