import { PolicyDeniedError, UnauthenticatedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { ActorRef } from '@oremedia/contracts/tenancy';
import { runAsPlatform, type TenantContext, type Tx } from '@oremedia/db';
import { UserDirectory } from './repositories';
import { hashToken } from './authenticator';

const directory = new UserDirectory();

export type Principal =
  | { kind: 'user'; userId: string; sessionId: string; selectedTenantId: string | null }
  | {
      kind: 'api_client';
      apiClientId: string;
      servicePrincipalId: string;
      tenantId: string;
      scopes: string[];
    }
  | {
      kind: 'external_reviewer';
      linkId: string;
      tenantId: string;
      brandId: string;
      reviewRequestId: string;
      revoked: boolean;
      expired: boolean;
    }
  | {
      kind: 'platform_operator';
      operatorId: string;
      supportSessionId: string;
      tenantId: string;
      mode: 'read_only' | 'escalated';
      expired: boolean;
    };

/** Authenticates a bearer credential of any kind. Returns null for an unknown or expired credential. */
export async function authenticate(bearer: string | undefined, tx?: Tx): Promise<Principal | null> {
  if (!bearer) return null;
  const hash = hashToken(bearer);
  return runAsPlatform('authenticate', 'authn', async () => {
    if (bearer.startsWith('ses_')) {
      const s = await directory.sessionByTokenHash(hash, tx);
      return s
        ? { kind: 'user', userId: s.userId, sessionId: s.id, selectedTenantId: s.selectedTenantId }
        : null;
    }
    if (bearer.startsWith('ak_')) {
      const c = await directory.apiClientByKeyHash(hash, tx);
      if (!c || (c.expiresAt && c.expiresAt.getTime() < Date.now())) return null;
      return {
        kind: 'api_client',
        apiClientId: c.id,
        servicePrincipalId: c.servicePrincipalId,
        tenantId: c.tenantId,
        scopes: c.scopes,
      };
    }
    if (bearer.startsWith('rl_')) {
      const l = await directory.reviewerLinkByTokenHash(hash, tx);
      if (!l) return null;
      return {
        kind: 'external_reviewer',
        linkId: l.id,
        tenantId: l.tenantId,
        brandId: l.brandId,
        reviewRequestId: l.reviewRequestId,
        revoked: l.revokedAt !== null,
        expired: l.expiresAt.getTime() < Date.now(),
      };
    }
    if (bearer.startsWith('sup_')) {
      // Support session tokens are session tokens of an operator user bound to a support session id: "sup_<sessionToken>.<supportSessionId>".
      const [tokenPart, supportSessionId] = bearer.slice(4).split('.');
      if (!tokenPart || !supportSessionId) return null;
      const s = await directory.sessionByTokenHash(hashToken(`ses_${tokenPart}`), tx);
      const ss = await directory.supportSessionById(supportSessionId, tx);
      if (!s || !ss || ss.operatorId !== s.userId || ss.closedAt) return null;
      return {
        kind: 'platform_operator',
        operatorId: s.userId,
        supportSessionId: ss.id,
        tenantId: ss.tenantId,
        mode: ss.mode,
        expired: ss.expiresAt.getTime() < Date.now(),
      };
    }
    return null;
  });
}

export interface ResolvedTenant {
  context: TenantContext;
  actor: ResolvedActor;
  actorRef: ActorRef;
}

/**
 * Spec 7.1: the tenant is a *selection* (X-Oremedia-Tenant header or session default), verified against active
 * memberships or the credential's own tenant. It is never trusted on its own.
 */
export async function resolveTenantContext(
  principal: Principal,
  requestedTenantId: string | undefined,
  correlationId: string,
  tx?: Tx,
): Promise<ResolvedTenant> {
  switch (principal.kind) {
    case 'user': {
      const tenantId = requestedTenantId ?? principal.selectedTenantId ?? undefined;
      if (!tenantId) throw new PolicyDeniedError('tenant_not_selected', 'Select a company first');
      const found = await runAsPlatform('resolve-tenant', correlationId, () =>
        directory.membershipFor(principal.userId, tenantId, tx),
      );
      const tenant = await runAsPlatform('resolve-tenant', correlationId, () =>
        directory.tenantById(tenantId, tx),
      );
      const user = await runAsPlatform('resolve-tenant', correlationId, () =>
        directory.findById(principal.userId, tx),
      );
      if (!found || !tenant || !user)
        throw new PolicyDeniedError('membership_missing', 'You are not a member of this company');
      if (tenant.status !== 'active')
        throw new PolicyDeniedError('tenant_inactive', 'This company is not active');
      const { membership, grants } = found;
      const brandIds = membership.allBrands ? ('all' as const) : new Set(grants.map((g) => g.brandId));
      const actor: ResolvedActor = {
        kind: 'user',
        id: user.id,
        tenantId,
        membershipId: membership.id,
        membershipStatus: membership.status,
        role: membership.role,
        allBrands: membership.allBrands,
        brandGrants: grants.map((g) => ({ brandId: g.brandId, roles: g.roles })),
        mfaEnrolled: user.mfaEnrolled,
      };
      if (membership.status !== 'active')
        throw new PolicyDeniedError('membership_inactive', 'Your membership is not active');
      return {
        context: { tenantId, actor: { kind: 'user', id: user.id }, brandIds, correlationId },
        actor,
        actorRef: { kind: 'user', id: user.id },
      };
    }
    case 'api_client': {
      if (requestedTenantId && requestedTenantId !== principal.tenantId)
        throw new PolicyDeniedError('tenant_mismatch', 'This credential belongs to another company');
      const sp = await runAsPlatform('resolve-tenant', correlationId, () =>
        directory.servicePrincipalFor(principal.servicePrincipalId, principal.tenantId, tx),
      );
      if (!sp || sp.status !== 'active') throw new UnauthenticatedError('Credential revoked');
      const brandSet = new Set<string>();
      let all = false;
      for (const g of sp.grants) {
        if (g.brandIds === 'all') all = true;
        else g.brandIds.forEach((b) => brandSet.add(b));
      }
      const actor: ResolvedActor = {
        kind: 'service_principal',
        id: sp.id,
        tenantId: sp.tenantId,
        status: sp.status,
        maxAutonomy: sp.maxAutonomy,
        grants: sp.grants,
      };
      return {
        context: {
          tenantId: sp.tenantId,
          actor: { kind: 'service_principal', id: sp.id },
          brandIds: all ? 'all' : brandSet,
          correlationId,
        },
        actor,
        actorRef: { kind: 'service_principal', id: sp.id },
      };
    }
    case 'external_reviewer': {
      if (requestedTenantId && requestedTenantId !== principal.tenantId)
        throw new PolicyDeniedError('tenant_mismatch');
      const actor: ResolvedActor = {
        kind: 'external_reviewer',
        id: principal.linkId,
        tenantId: principal.tenantId,
        reviewRequestId: principal.reviewRequestId,
        brandId: principal.brandId,
        revoked: principal.revoked,
        expired: principal.expired,
      };
      return {
        context: {
          tenantId: principal.tenantId,
          actor: { kind: 'external_reviewer', id: principal.linkId },
          brandIds: new Set([principal.brandId]),
          correlationId,
        },
        actor,
        actorRef: { kind: 'external_reviewer', id: principal.linkId },
      };
    }
    case 'platform_operator': {
      if (requestedTenantId && requestedTenantId !== principal.tenantId)
        throw new PolicyDeniedError('tenant_mismatch', 'Support session is bound to one company');
      const actor: ResolvedActor = {
        kind: 'platform_operator',
        id: principal.operatorId,
        tenantId: principal.tenantId,
        supportSessionId: principal.supportSessionId,
        mode: principal.mode,
        expired: principal.expired,
      };
      return {
        context: {
          tenantId: principal.tenantId,
          actor: { kind: 'platform_operator', id: principal.operatorId },
          brandIds: 'all',
          correlationId,
          supportSessionId: principal.supportSessionId,
        },
        actor,
        actorRef: { kind: 'platform_operator', id: principal.operatorId },
      };
    }
  }
}
