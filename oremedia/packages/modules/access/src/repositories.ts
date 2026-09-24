import { and, eq, gt, isNull, or, type SQL } from 'drizzle-orm';
import { PlatformRepository, TenantScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import {
  apiClients,
  brandGrants,
  externalReviewerLinks,
  memberships,
  servicePrincipals,
  sessions,
  supportSessions,
  tenants,
  users,
} from '@oremedia/db/schema/access';

/** Global tables (users, tenants, sessions) are read through explicit, narrow finders; they are never tenant-scoped. */
export class UserDirectory extends PlatformRepository {
  async findByEmail(email: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  }
  async findById(id: string, tx?: Tx) {
    const rows = await this.conn(tx).select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  }
  async create(values: typeof users.$inferInsert, tx?: Tx) {
    await this.conn(tx)
      .insert(users)
      .values({ ...values, email: values.email.toLowerCase() });
  }
  async tenantById(id: string, tx?: Tx) {
    const rows = await this.conn(tx).select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return rows[0] ?? null;
  }
  async tenantBySlug(slug: string, tx?: Tx) {
    const rows = await this.conn(tx).select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    return rows[0] ?? null;
  }
  async createTenant(values: typeof tenants.$inferInsert, tx?: Tx) {
    await this.conn(tx).insert(tenants).values(values);
  }
  /** Bootstrap only: the owner membership of a tenant being created, before any tenant context exists. */
  async createMembership(values: typeof memberships.$inferInsert, tx?: Tx) {
    await this.conn(tx).insert(memberships).values(values);
  }
  /** Memberships for one user across tenants: the portfolio projection (spec 5.1). */
  async membershipsForUser(userId: string, tx?: Tx) {
    return this.conn(tx)
      .select({ membership: memberships, tenant: tenants })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(eq(memberships.userId, userId), eq(memberships.status, 'active'), eq(tenants.status, 'active')),
      );
  }
  async sessionByTokenHash(tokenHash: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.tokenHash, tokenHash),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  async createSession(values: typeof sessions.$inferInsert, tx?: Tx) {
    await this.conn(tx).insert(sessions).values(values);
  }
  async revokeSessionsForUser(userId: string, tx?: Tx) {
    await this.conn(tx)
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }
  /**
   * Spec 17.5 user identity after a tenant deletion: a user left with no membership in any tenant keeps a
   * pseudonymous row (audit events refer to the id) with the personal fields replaced, and every session revoked.
   * A user who still belongs to another tenant is untouched. Returns whether the user was anonymised.
   */
  async anonymiseIfUnaffiliated(userId: string, tx?: Tx): Promise<boolean> {
    const remaining = await this.conn(tx)
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.userId, userId))
      .limit(1);
    if (remaining.length) return false;
    await this.conn(tx)
      .update(users)
      .set({
        email: `deleted+${userId.toLowerCase()}@deleted.invalid`,
        name: 'Deleted user',
        status: 'deleted',
        passwordHash: null,
        mfaEnrolled: false,
      })
      .where(eq(users.id, userId));
    await this.revokeSessionsForUser(userId, tx);
    return true;
  }
  /** Spec 17.5 tenant deletion: the tenant row stays as a tombstone (audit rows name it) without its name. */
  async closeTenant(tenantId: string, tx?: Tx) {
    await this.conn(tx)
      .update(tenants)
      .set({
        name: 'Deleted tenant',
        slug: `deleted-${tenantId.toLowerCase()}`.slice(0, 80),
        status: 'closing',
        policy: null,
      })
      .where(eq(tenants.id, tenantId));
  }
  async revokeSession(id: string, tx?: Tx) {
    await this.conn(tx).update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, id));
  }
  async setSelectedTenant(sessionId: string, tenantId: string, tx?: Tx) {
    await this.conn(tx)
      .update(sessions)
      .set({ selectedTenantId: tenantId, lastSeenAt: new Date() })
      .where(eq(sessions.id, sessionId));
  }
  async apiClientByKeyHash(keyHash: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(apiClients)
      .where(and(eq(apiClients.keyHash, keyHash), eq(apiClients.status, 'active')))
      .limit(1);
    return rows[0] ?? null;
  }
  async reviewerLinkByTokenHash(tokenHash: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(externalReviewerLinks)
      .where(eq(externalReviewerLinks.tokenHash, tokenHash))
      .limit(1);
    return rows[0] ?? null;
  }
  async supportSessionById(id: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(supportSessions)
      .where(eq(supportSessions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }
  async openSupportSession(values: typeof supportSessions.$inferInsert, tx?: Tx) {
    await this.conn(tx).insert(supportSessions).values(values);
  }
  async closeSupportSession(id: string, tx?: Tx) {
    await this.conn(tx)
      .update(supportSessions)
      .set({ closedAt: new Date() })
      .where(eq(supportSessions.id, id));
  }
  /** Membership + grants for a (user, tenant) pair, read by the resolver before tenant context exists. */
  async membershipFor(userId: string, tenantId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
      .limit(1);
    const m = rows[0];
    if (!m) return null;
    const grants = await this.conn(tx)
      .select()
      .from(brandGrants)
      .where(and(eq(brandGrants.tenantId, tenantId), eq(brandGrants.membershipId, m.id)));
    return { membership: m, grants };
  }
  async servicePrincipalFor(id: string, tenantId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(servicePrincipals)
      .where(and(eq(servicePrincipals.tenantId, tenantId), eq(servicePrincipals.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }
}

export class MembershipRepository extends TenantScopedRepository<typeof memberships> {
  constructor() {
    super(memberships);
  }
  async list(tx?: Tx) {
    return this.conn(tx).select().from(memberships).where(this.scope());
  }
  async findByUser(userId: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(memberships)
      .where(this.scope(eq(memberships.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }
  async findByInvitedEmail(email: string, tx?: Tx) {
    const rows = await this.conn(tx)
      .select()
      .from(memberships)
      .where(this.scope(eq(memberships.invitedEmail, email.toLowerCase())))
      .limit(1);
    return rows[0] ?? null;
  }
  async create(values: Omit<typeof memberships.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof memberships.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async countActive(tx?: Tx) {
    const rows = await this.conn(tx)
      .select({ id: memberships.id })
      .from(memberships)
      .where(this.scope(or(eq(memberships.status, 'active'), eq(memberships.status, 'invited')) as SQL));
    return rows.length;
  }
}

export class BrandGrantRepository extends TenantScopedRepository<typeof brandGrants> {
  constructor() {
    super(brandGrants);
  }
  async forMembership(membershipId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(brandGrants)
      .where(this.scope(eq(brandGrants.membershipId, membershipId)));
  }
  async set(values: Omit<typeof brandGrants.$inferInsert, 'tenantId'>, tx?: Tx) {
    const { tenantId } = requireTenant();
    const existing = await this.conn(tx)
      .select()
      .from(brandGrants)
      .where(
        this.scope(
          and(eq(brandGrants.membershipId, values.membershipId), eq(brandGrants.brandId, values.brandId)),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await this.conn(tx)
        .update(brandGrants)
        .set({ roles: values.roles })
        .where(this.scope(eq(brandGrants.id, existing[0].id)));
      return existing[0].id;
    }
    await this.conn(tx)
      .insert(brandGrants)
      .values({ ...values, tenantId });
    return values.id;
  }
  async remove(membershipId: string, brandId: string, tx?: Tx) {
    await this.conn(tx)
      .delete(brandGrants)
      .where(this.scope(and(eq(brandGrants.membershipId, membershipId), eq(brandGrants.brandId, brandId))));
  }
}

export class ServicePrincipalRepository extends TenantScopedRepository<typeof servicePrincipals> {
  constructor() {
    super(servicePrincipals);
  }
  async list(tx?: Tx) {
    return this.conn(tx).select().from(servicePrincipals).where(this.scope());
  }
  async create(values: Omit<typeof servicePrincipals.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof servicePrincipals.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
}

export class ApiClientRepository extends TenantScopedRepository<typeof apiClients> {
  constructor() {
    super(apiClients);
  }
  async create(values: Omit<typeof apiClients.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof apiClients.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async listForPrincipal(servicePrincipalId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(apiClients)
      .where(this.scope(eq(apiClients.servicePrincipalId, servicePrincipalId)));
  }
}

export class ExternalReviewerLinkRepository extends TenantScopedRepository<typeof externalReviewerLinks> {
  constructor() {
    super(externalReviewerLinks);
  }
  async create(values: Omit<typeof externalReviewerLinks.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof externalReviewerLinks.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  async listForRequest(reviewRequestId: string, tx?: Tx) {
    return this.conn(tx)
      .select()
      .from(externalReviewerLinks)
      .where(this.scope(eq(externalReviewerLinks.reviewRequestId, reviewRequestId)));
  }
}
