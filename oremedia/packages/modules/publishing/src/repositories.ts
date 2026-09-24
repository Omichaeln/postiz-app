import { and, asc, desc, eq, gte, inArray, lt, lte, ne, sql, type SQL } from 'drizzle-orm';
import { NotFoundError } from '@oremedia/contracts/errors';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import type { PublicationState } from '@oremedia/contracts/publishing';
import {
  BrandScopedRepository,
  PlatformRepository,
  TenantScopedRepository,
  affectedRows,
  requireTenant,
  type Tx,
} from '@oremedia/db';
import {
  channelConnections,
  credentialRefs,
  publicationAttempts,
  publications,
  remoteEvidence,
} from '@oremedia/db/schema/publishing';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

/** Spec 7.4: newest first by id (ULIDs are time-ordered); cursor = opaque base64 of the id. */
function pageOf<T extends { id: string }>(rows: T[], page: PageRequest): Page<T> {
  const items = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? rows[page.limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

/**
 * Credential envelopes (spec 14.7). Rows are never updated in place except to retire them: rotation writes a new
 * row and destroys the old one (destroyedAt + ciphertext and wrapped key overwritten, so the data key is gone).
 */
export class CredentialRefRepository extends TenantScopedRepository<typeof credentialRefs> {
  constructor() {
    super(credentialRefs);
  }
  async create(values: Omit<typeof credentialRefs.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertScoped(values, tx);
  }
  /** Crypto-shred: the wrapped data key and ciphertext are overwritten, the row stays as evidence of the rotation. */
  async destroy(id: string, expectedVersion: number, reason: 'rotated' | 'disconnected', tx: Tx) {
    const now = new Date();
    await this.updateScoped(
      id,
      expectedVersion,
      {
        destroyedAt: now,
        ...(reason === 'rotated' ? { rotatedAt: now } : {}),
        wrappedDataKey: '',
        ciphertext: '',
      },
      tx,
    );
  }
}

export class ChannelConnectionRepository extends BrandScopedRepository<typeof channelConnections> {
  constructor() {
    super(channelConnections);
  }
  /** SELECT ... FOR UPDATE: credential rotation and disconnect serialise on the connection row. */
  async lock(id: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(channelConnections)
      .where(this.scope(eq(channelConnections.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('ChannelConnection', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  async findByRemoteAccount(providerKey: string, remoteAccountId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(channelConnections)
      .where(
        this.scope(
          and(
            eq(channelConnections.providerKey, providerKey),
            eq(channelConnections.remoteAccountId, remoteAccountId),
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
  async create(values: Omit<typeof channelConnections.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof channelConnections.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async listForBrand(brandId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(channelConnections)
      .where(this.brandScope(brandId))
      .orderBy(asc(channelConnections.id));
  }
  /** Usage counter for the `channels` entitlement (spec 5.5 step 6). */
  async countActive(tx?: Tx): Promise<number> {
    const rows = await this.conn(tx)
      .select({ c: sql<number>`count(*)` })
      .from(channelConnections)
      .where(this.scope(eq(channelConnections.status, 'active')));
    return Number(rows[0]?.c ?? 0);
  }
}

export class PublicationRepository extends BrandScopedRepository<typeof publications> {
  constructor() {
    super(publications);
  }
  /** SELECT ... FOR UPDATE: state moves under the row lock so a command and an activity cannot interleave. */
  async lock(id: string, tx: Tx) {
    const rows = await tx
      .select()
      .from(publications)
      .where(this.scope(eq(publications.id, id)))
      .for('update');
    const row = rows[0];
    if (!row) throw new NotFoundError('Publication', id);
    this.assertBrandAccess(row.brandId);
    return row;
  }
  async findByOccurrenceKey(occurrenceKey: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(publications)
      .where(this.scope(eq(publications.occurrenceKey, occurrenceKey)))
      .limit(1);
    return rows[0] ?? null;
  }
  async create(values: Omit<typeof publications.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof publications.$inferInsert>,
    tx: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async listForBrand(
    brandId: string,
    state: PublicationState | undefined,
    page: PageRequest,
    tx?: Tx,
  ): Promise<Page<typeof publications.$inferSelect>> {
    const clauses: SQL[] = [];
    if (state) clauses.push(eq(publications.state, state));
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    if (cursor) clauses.push(lte(publications.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(publications)
      .where(this.brandScope(brandId, clauses.length ? (and(...clauses) as SQL) : undefined))
      .orderBy(desc(publications.id))
      .limit(page.limit + 1);
    return pageOf(rows, page);
  }
  /** Spec 13.4 mandate_daily_quota: publications a mandate scheduled on the UTC day of `at` (all states but cancelled). */
  async countForMandateOnDay(mandateId: string, at: Date, tx?: Tx): Promise<number> {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const rows = await this.conn(tx)
      .select({ c: sql`count(*)` })
      .from(publications)
      .where(
        this.scope(
          and(
            eq(publications.mandateId, mandateId),
            gte(publications.scheduledFor, start),
            lt(publications.scheduledFor, end),
            ne(publications.state, 'cancelled'),
          ) as SQL,
        ),
      );
    return Number(rows[0]?.c ?? 0);
  }
  /** The scheduled publications of one channel (disconnect holds them, spec 14.7). */
  async listScheduledForChannel(channelConnectionId: string, tx: Tx) {
    return tx
      .select()
      .from(publications)
      .where(
        this.scope(
          and(
            eq(publications.channelConnectionId, channelConnectionId),
            eq(publications.state, 'scheduled'),
          ) as SQL,
        ),
      )
      .for('update');
  }
}

/**
 * Append-plus-outcome (spec 6.1): a row is inserted by openAttempt and its outcome columns are written once by the
 * attempt owner (fencing token checked). Nothing is ever deleted.
 */
export class PublicationAttemptRepository extends TenantScopedRepository<typeof publicationAttempts> {
  constructor() {
    super(publicationAttempts);
  }
  async create(values: Omit<typeof publicationAttempts.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertScoped(values, tx);
  }
  async findByFence(publicationId: string, fencingToken: number, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(publicationAttempts)
      .where(
        this.scope(
          and(
            eq(publicationAttempts.publicationId, publicationId),
            eq(publicationAttempts.fencingToken, fencingToken),
          ) as SQL,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  async listForPublication(publicationId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(publicationAttempts)
      .where(this.scope(eq(publicationAttempts.publicationId, publicationId)))
      .orderBy(asc(publicationAttempts.attemptNumber));
  }
  async countForPublication(publicationId: string, tx: Tx): Promise<number> {
    const rows = await tx
      .select({ c: sql<number>`count(*)` })
      .from(publicationAttempts)
      .where(this.scope(eq(publicationAttempts.publicationId, publicationId)));
    return Number(rows[0]?.c ?? 0);
  }
  /** sentAt is written once, immediately before the outbound mutation; a repeat is a no-op (idempotent). */
  async markSent(id: string, at: Date, tx: Tx): Promise<boolean> {
    const res = await tx
      .update(publicationAttempts)
      .set({ sentAt: at })
      .where(
        this.scope(and(eq(publicationAttempts.id, id), sql`${publicationAttempts.sentAt} is null`) as SQL),
      );
    return affectedRows(res) === 1;
  }
  /** The outcome is written once (finishedAt null → set); a repeat never overwrites the recorded outcome. */
  async recordOutcome(
    id: string,
    values: Pick<
      typeof publicationAttempts.$inferInsert,
      'outcome' | 'errorCode' | 'errorDetail' | 'remoteJobId' | 'remotePostId' | 'pendingState'
    >,
    at: Date,
    tx: Tx,
  ): Promise<boolean> {
    const res = await tx
      .update(publicationAttempts)
      .set({ ...values, finishedAt: at })
      .where(
        this.scope(
          and(eq(publicationAttempts.id, id), sql`${publicationAttempts.finishedAt} is null`) as SQL,
        ),
      );
    return affectedRows(res) === 1;
  }
  /** Reconciliation attaches the remote id it found to the attempt it reconciled (finishedAt already set). */
  async attachRemotePost(id: string, remotePostId: string, tx: Tx): Promise<void> {
    await tx
      .update(publicationAttempts)
      .set({ remotePostId })
      .where(
        this.scope(
          and(eq(publicationAttempts.id, id), sql`${publicationAttempts.remotePostId} is null`) as SQL,
        ),
      );
  }
}

/** Insert-only (spec 6.1). */
export class RemoteEvidenceRepository extends TenantScopedRepository<typeof remoteEvidence> {
  constructor() {
    super(remoteEvidence);
  }
  async create(values: Omit<typeof remoteEvidence.$inferInsert, 'tenantId'>, tx: Tx) {
    await this.insertScoped(values, tx);
  }
  async listForPublication(publicationId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(remoteEvidence)
      .where(this.scope(eq(remoteEvidence.publicationId, publicationId)))
      .orderBy(asc(remoteEvidence.capturedAt), asc(remoteEvidence.id));
  }
  /** Idempotency of markPublished: one evidence row per (publication, attempt, kind). */
  async exists(
    publicationId: string,
    attemptId: string | null,
    kind: (typeof remoteEvidence.$inferSelect)['kind'],
    tx: Tx,
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: remoteEvidence.id })
      .from(remoteEvidence)
      .where(
        this.scope(
          and(
            eq(remoteEvidence.publicationId, publicationId),
            attemptId === null
              ? sql`${remoteEvidence.attemptId} is null`
              : eq(remoteEvidence.attemptId, attemptId),
            eq(remoteEvidence.kind, kind),
          ) as SQL,
        ),
      )
      .limit(1);
    return rows.length === 1;
  }
}

/** A stuck publication as the sweeper sees it: references only, never tenant content. */
export interface StuckPublicationRef {
  tenantId: string;
  publicationId: string;
  state: 'scheduled' | 'dispatching';
  claimant: string | null;
  version: number;
}

/**
 * The sweeper legitimately spans tenants (like the outbox dispatcher, spec 14.2) and runs as a declared platform
 * job. It reads references only; every write happens afterwards inside the row's own tenant context.
 */
export class PublicationSweepRepository extends PlatformRepository {
  async findStuck(
    now: Date,
    graceSeconds: number,
    claimLeaseSeconds: number,
    limit = 200,
  ): Promise<StuckPublicationRef[]> {
    const dueBefore = new Date(now.getTime() - graceSeconds * 1000);
    const claimedBefore = new Date(now.getTime() - claimLeaseSeconds * 1000);
    const rows = await this.conn()
      .select({
        tenantId: publications.tenantId,
        publicationId: publications.id,
        state: publications.state,
        claimant: publications.claimant,
        version: publications.version,
      })
      .from(publications)
      .where(
        and(
          inArray(publications.state, ['scheduled', 'dispatching']),
          sql`case when ${publications.state} = 'scheduled' then ${publications.scheduledFor} < ${dueBefore} else coalesce(${publications.claimedAt}, ${publications.updatedAt}) < ${claimedBefore} end`,
        ),
      )
      .orderBy(asc(publications.scheduledFor))
      .limit(limit);
    return rows.map((r) => ({
      tenantId: r.tenantId,
      publicationId: r.publicationId,
      state: r.state as 'scheduled' | 'dispatching',
      claimant: r.claimant,
      version: r.version,
    }));
  }
}
