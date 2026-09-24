import type { z } from 'zod';
import {
  ApiClientCreate,
  ApiClientRotate,
  BrandGrantSet,
  ExternalLinkCreate,
  ExternalLinkRevoke,
  MemberInvite,
  MemberSetRole,
  ServicePrincipalCreate,
  ServicePrincipalRevoke,
  SupportSessionOpen,
  TenantCreate,
} from '@oremedia/contracts/access';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, runAsPlatform, withTransaction, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { audit, outbox } from '@oremedia/module-operations';
import {
  ApiClientRepository,
  BrandGrantRepository,
  ExternalReviewerLinkRepository,
  MembershipRepository,
  ServicePrincipalRepository,
  UserDirectory,
} from './repositories';
import { newOpaqueToken } from './authenticator';
import { policy } from './policy';

const directory = new UserDirectory();
const membershipsRepo = new MembershipRepository();
const grantsRepo = new BrandGrantRepository();
const principalsRepo = new ServicePrincipalRepository();
const apiClientsRepo = new ApiClientRepository();
const linksRepo = new ExternalReviewerLinkRepository();

const tenantResource = (actor: ResolvedActor) => ({
  type: 'tenant',
  tenantId: actor.tenantId,
  id: actor.tenantId,
});

/** Brand existence is owned by the brand module; the composition root registers its checker here (no table sharing). */
type BrandChecker = {
  assertExist(brandIds: string[], tx?: Tx): Promise<void>;
  assertValidGrantBrands(brandIds: string[], tx?: Tx): Promise<void>;
};
let brandChecker: BrandChecker | null = null;
export const registerBrandChecker = (c: BrandChecker): void => {
  brandChecker = c;
};
const brands = (): BrandChecker => {
  if (!brandChecker)
    throw new Error('brand checker not registered (composition root must call registerBrandChecker)');
  return brandChecker;
};

export const accessService = {
  /** Bootstrap: creates a tenant and its owner membership. Called by sign-up, outside any tenant context. */
  async createTenantWithOwner(
    input: z.infer<typeof TenantCreate>,
    ownerUserId: string,
    correlationId: string,
  ): Promise<{ tenantId: string; membershipId: string }> {
    const parsed = TenantCreate.parse(input);
    const tenantId = newId('tenant');
    const membershipId = newId('membership');
    await runAsPlatform('tenant-bootstrap', correlationId, () =>
      withTransaction(async (tx) => {
        await directory.createTenant({ id: tenantId, name: parsed.name, slug: parsed.slug }, tx);
        await directory.createMembership(
          {
            id: membershipId,
            tenantId,
            userId: ownerUserId,
            role: 'owner',
            status: 'active',
            allBrands: true,
          },
          tx,
        );
      }),
    );
    return { tenantId, membershipId };
  },

  async me(actor: ResolvedActor) {
    const ctx = requireTenant();
    return { actor, tenantId: ctx.tenantId, brandIds: ctx.brandIds === 'all' ? 'all' : [...ctx.brandIds] };
  },

  /** Portfolio: authorised companies as a projection over memberships (spec 5.1). */
  async listCompanies(userId: string, correlationId: string, tx?: Tx) {
    const rows = await runAsPlatform('portfolio', correlationId, () =>
      directory.membershipsForUser(userId, tx),
    );
    return rows.map((r) => ({
      tenantId: r.tenant.id,
      name: r.tenant.name,
      slug: r.tenant.slug,
      role: r.membership.role,
      allBrands: r.membership.allBrands,
    }));
  },

  async switchCompany(
    sessionId: string,
    userId: string,
    tenantId: string,
    correlationId: string,
    tx?: Tx,
  ): Promise<void> {
    await runAsPlatform('switch-company', correlationId, async () => {
      const m = await directory.membershipFor(userId, tenantId, tx);
      if (!m || m.membership.status !== 'active')
        throw new PolicyDeniedError('membership_missing', 'You are not a member of this company');
      await directory.setSelectedTenant(sessionId, tenantId, tx);
    });
  },

  async inviteMember(actor: ResolvedActor, input: z.infer<typeof MemberInvite>, tx: Tx) {
    const parsed = MemberInvite.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    if (parsed.role === 'owner' && actor.kind === 'user' && actor.role !== 'owner')
      throw new PolicyDeniedError('owner_required', 'Only an owner can invite another owner');
    const existingUser = await runAsPlatform('invite', requireTenant().correlationId, () =>
      directory.findByEmail(parsed.email, tx),
    );
    const id = newId('membership');
    if (existingUser) {
      const dup = await membershipsRepo.findByUser(existingUser.id, tx);
      if (dup) throw new ValidationFailedError([{ path: 'email', issue: 'already_member' }]);
      await membershipsRepo.create(
        {
          id,
          userId: existingUser.id,
          role: parsed.role,
          status: 'invited',
          allBrands: parsed.allBrands,
          invitedEmail: parsed.email.toLowerCase(),
        },
        tx,
      );
    } else {
      // Placeholder user row so the membership can exist before first sign-in (status disabled until claimed).
      const userId = newId('user');
      await runAsPlatform('invite', requireTenant().correlationId, () =>
        directory.create(
          {
            id: userId,
            email: parsed.email,
            name: parsed.email.split('@')[0] ?? 'invited',
            status: 'disabled',
          },
          tx,
        ),
      );
      await membershipsRepo.create(
        {
          id,
          userId,
          role: parsed.role,
          status: 'invited',
          allBrands: parsed.allBrands,
          invitedEmail: parsed.email.toLowerCase(),
        },
        tx,
      );
    }
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'membership.invite',
      { type: 'membership', id },
      'allowed',
      tx,
    );
    await outbox.add(
      'membership.changed',
      { type: 'membership', id, version: 0 },
      { membershipId: id, change: 'invited' },
      tx,
    );
    return { membershipId: id };
  },

  async setRole(actor: ResolvedActor, input: z.infer<typeof MemberSetRole>, tx: Tx) {
    const parsed = MemberSetRole.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const m = await membershipsRepo.getById(parsed.membershipId, tx);
    if ((m.role === 'owner' || parsed.role === 'owner') && actor.kind === 'user' && actor.role !== 'owner')
      throw new PolicyDeniedError('owner_required');
    await membershipsRepo.update(
      m.id,
      parsed.expectedVersion,
      { role: parsed.role, ...(parsed.allBrands !== undefined ? { allBrands: parsed.allBrands } : {}) },
      tx,
    );
    // Privilege change invalidates the member's sessions (spec 18 authentication baseline).
    await runAsPlatform('set-role', requireTenant().correlationId, () =>
      directory.revokeSessionsForUser(m.userId, tx),
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'membership.set_role',
      { type: 'membership', id: m.id },
      'allowed',
      tx,
      { toState: parsed.role },
    );
    await outbox.add(
      'membership.changed',
      { type: 'membership', id: m.id, version: parsed.expectedVersion + 1 },
      { membershipId: m.id, change: 'role' },
      tx,
    );
  },

  async setBrandGrant(actor: ResolvedActor, input: z.infer<typeof BrandGrantSet>, tx: Tx) {
    const parsed = BrandGrantSet.parse(input);
    await brands().assertExist([parsed.brandId], tx);
    await policy.assert(
      actor,
      'membership.manage',
      { type: 'brand', tenantId: actor.tenantId, brandId: parsed.brandId },
      {},
      tx,
    );
    const m = await membershipsRepo.getById(parsed.membershipId, tx);
    const id = await grantsRepo.set(
      { id: newId('brandGrant'), membershipId: m.id, brandId: parsed.brandId, roles: parsed.roles },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'brand_grant.set',
      { type: 'brand_grant', id },
      'allowed',
      tx,
      { brandId: parsed.brandId },
    );
    return { grantId: id };
  },

  async createServicePrincipal(actor: ResolvedActor, input: z.infer<typeof ServicePrincipalCreate>, tx: Tx) {
    const parsed = ServicePrincipalCreate.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    if (actor.kind !== 'user')
      throw new PolicyDeniedError('agent_never', 'Only a person can create a service principal');
    const grantBrandIds = [
      ...new Set(parsed.grants.flatMap((g) => (g.brandIds === 'all' ? [] : g.brandIds))),
    ];
    await brands().assertValidGrantBrands(grantBrandIds, tx);
    const id = newId('servicePrincipal');
    await principalsRepo.create(
      {
        id,
        kind: parsed.kind,
        name: parsed.name,
        grants: parsed.grants,
        maxAutonomy: parsed.maxAutonomy,
        status: 'active',
        createdByUserId: actor.id,
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'service_principal.create',
      { type: 'service_principal', id },
      'allowed',
      tx,
    );
    return { servicePrincipalId: id };
  },

  async revokeServicePrincipal(actor: ResolvedActor, input: z.infer<typeof ServicePrincipalRevoke>, tx: Tx) {
    const parsed = ServicePrincipalRevoke.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const sp = await principalsRepo.getById(parsed.servicePrincipalId, tx);
    await principalsRepo.update(sp.id, parsed.expectedVersion, { status: 'revoked' }, tx);
    for (const c of await apiClientsRepo.listForPrincipal(sp.id, tx))
      if (c.status === 'active') await apiClientsRepo.update(c.id, c.version, { status: 'revoked' }, tx);
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'service_principal.revoke',
      { type: 'service_principal', id: sp.id },
      'allowed',
      tx,
    );
  },

  /** Returns the plaintext key exactly once; only the hash and prefix are stored (spec 7.6). */
  async createApiClient(actor: ResolvedActor, input: z.infer<typeof ApiClientCreate>, tx: Tx) {
    const parsed = ApiClientCreate.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const sp = await principalsRepo.getById(parsed.servicePrincipalId, tx);
    if (sp.status !== 'active')
      throw new ValidationFailedError([{ path: 'servicePrincipalId', issue: 'revoked' }]);
    const { token, hash, prefixForLookup } = newOpaqueToken('ak');
    const id = newId('apiClient');
    await apiClientsRepo.create(
      {
        id,
        servicePrincipalId: sp.id,
        keyHash: hash,
        keyPrefix: prefixForLookup,
        scopes: parsed.scopes,
        expiresAt: parsed.expiresAt ? new Date(parsed.expiresAt) : null,
        status: 'active',
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'api_client.create',
      { type: 'api_client', id },
      'allowed',
      tx,
    );
    return { apiClientId: id, key: token, keyPrefix: prefixForLookup };
  },

  async rotateApiClient(actor: ResolvedActor, input: z.infer<typeof ApiClientRotate>, tx: Tx) {
    const parsed = ApiClientRotate.parse(input);
    await policy.assert(actor, 'membership.manage', tenantResource(actor), {}, tx);
    const old = await apiClientsRepo.getById(parsed.apiClientId, tx);
    await apiClientsRepo.update(old.id, old.version, { status: 'revoked' }, tx);
    const { token, hash, prefixForLookup } = newOpaqueToken('ak');
    const id = newId('apiClient');
    await apiClientsRepo.create(
      {
        id,
        servicePrincipalId: old.servicePrincipalId,
        keyHash: hash,
        keyPrefix: prefixForLookup,
        scopes: old.scopes,
        expiresAt: old.expiresAt,
        status: 'active',
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'api_client.rotate',
      { type: 'api_client', id },
      'allowed',
      tx,
    );
    return { apiClientId: id, key: token, keyPrefix: prefixForLookup };
  },

  /** Spec 5.6: single-use-per-session, expiring, revocable token bound to one review request. */
  async createExternalReviewerLink(
    actor: ResolvedActor,
    input: z.infer<typeof ExternalLinkCreate>,
    brandId: string,
    tx: Tx,
  ) {
    const parsed = ExternalLinkCreate.parse(input);
    await policy.assert(
      actor,
      'review.request',
      { type: 'review_request', tenantId: actor.tenantId, brandId, id: parsed.reviewRequestId },
      {},
      tx,
    );
    if (actor.kind !== 'user') throw new PolicyDeniedError('agent_never');
    const { token, hash } = newOpaqueToken('rl');
    const id = newId('externalReviewerLink');
    await linksRepo.create(
      {
        id,
        brandId,
        reviewRequestId: parsed.reviewRequestId,
        tokenHash: hash,
        email: parsed.email.toLowerCase(),
        expiresAt: new Date(parsed.expiresAt),
        createdByUserId: actor.id,
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'external_link.create',
      { type: 'external_reviewer_link', id },
      'allowed',
      tx,
      { brandId },
    );
    return { linkId: id, token };
  },

  async revokeExternalReviewerLink(actor: ResolvedActor, input: z.infer<typeof ExternalLinkRevoke>, tx: Tx) {
    const parsed = ExternalLinkRevoke.parse(input);
    const link = await linksRepo.getById(parsed.linkId, tx);
    await policy.assert(
      actor,
      'review.request',
      { type: 'review_request', tenantId: actor.tenantId, brandId: link.brandId, id: link.reviewRequestId },
      {},
      tx,
    );
    await linksRepo.update(link.id, link.version, { revokedAt: new Date() }, tx);
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'external_link.revoke',
      { type: 'external_reviewer_link', id: link.id },
      'allowed',
      tx,
    );
  },

  /** Spec 5.7: support sessions are opened by platform operators, outside tenant context, and audited on use. */
  async openSupportSession(
    operatorId: string,
    input: z.infer<typeof SupportSessionOpen>,
    correlationId: string,
  ): Promise<{ supportSessionId: string; expiresAt: Date }> {
    const parsed = SupportSessionOpen.parse(input);
    const id = newId('supportSession');
    const expiresAt = new Date(Date.now() + parsed.durationMinutes * 60_000);
    await runAsPlatform('support-session', correlationId, async () => {
      const tenant = await directory.tenantById(parsed.tenantId);
      if (!tenant) throw new NotFoundError('Tenant', parsed.tenantId);
      await directory.openSupportSession({
        id,
        operatorId,
        tenantId: parsed.tenantId,
        reason: parsed.reason,
        ticketRef: parsed.ticketRef,
        consentRecorded: parsed.consentRecorded,
        mode: 'read_only',
        expiresAt,
      });
    });
    return { supportSessionId: id, expiresAt };
  },
};
