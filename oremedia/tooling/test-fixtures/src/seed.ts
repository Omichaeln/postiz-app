import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import { appRouter, composeModules, createContext, envelopeFor } from '@oremedia/api';
import { runInTenant, type Db } from '@oremedia/db';
import {
  apiClients,
  brandGrants,
  memberships,
  servicePrincipals,
  sessions,
  tenants,
  users,
} from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { auditEvents, deletionRequests, killSwitches, outboxEvents } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { hashToken, newOpaqueToken } from '@oremedia/module-access';
import type { ErrorEnvelope } from '@oremedia/contracts/errors';
import { SEED_EXTENSIONS } from './cross-tenant-inputs';

export interface SeededTenant {
  tenantId: string;
  ownerUserId: string;
  ownerToken: string;
  ownerMembershipId: string;
  creatorUserId: string;
  creatorToken: string;
  creatorMembershipId: string;
  brandIds: [string, string];
  servicePrincipalId: string;
  apiClientId: string;
  apiClientKey: string;
  /** Every id a foreign caller might try to use. */
  ids: Record<string, string>;
  snapshot(): Promise<string>;
}

async function seedTenant(db: Db, label: string): Promise<SeededTenant> {
  const tenantId = newId('tenant');
  const ownerUserId = newId('user');
  const creatorUserId = newId('user');
  const ownerMembershipId = newId('membership');
  const creatorMembershipId = newId('membership');
  const brandIds: [string, string] = [newId('brand'), newId('brand')];
  const servicePrincipalId = newId('servicePrincipal');
  const apiClientId = newId('apiClient');
  await db.insert(tenants).values({
    id: tenantId,
    name: `Tenant ${label}`,
    slug: `t-${label}-${tenantId.slice(-8).toLowerCase()}`,
  });
  await db.insert(users).values([
    {
      id: ownerUserId,
      email: `${label}-owner-${tenantId.slice(-6).toLowerCase()}@example.test`,
      name: `${label} owner`,
    },
    {
      id: creatorUserId,
      email: `${label}-creator-${tenantId.slice(-6).toLowerCase()}@example.test`,
      name: `${label} creator`,
    },
  ]);
  await db.insert(memberships).values([
    {
      id: ownerMembershipId,
      tenantId,
      userId: ownerUserId,
      role: 'owner',
      status: 'active',
      allBrands: true,
    },
    {
      id: creatorMembershipId,
      tenantId,
      userId: creatorUserId,
      role: 'creator',
      status: 'active',
      allBrands: false,
    },
  ]);
  await db.insert(brands).values([
    {
      id: brandIds[0],
      tenantId,
      name: `${label} brand 1`,
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    },
    {
      id: brandIds[1],
      tenantId,
      name: `${label} brand 2`,
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    },
  ]);
  // The creator is restricted to brand 1 only.
  await db.insert(brandGrants).values({
    id: newId('brandGrant'),
    tenantId,
    membershipId: creatorMembershipId,
    brandId: brandIds[0],
    roles: [],
  });
  await db.insert(servicePrincipals).values({
    id: servicePrincipalId,
    tenantId,
    kind: 'agent',
    name: `${label} agent`,
    grants: [{ action: 'brand.read', brandIds: 'all' }],
    maxAutonomy: 'create',
    status: 'active',
    createdByUserId: ownerUserId,
  });
  const apiKey = newOpaqueToken('ak');
  await db.insert(apiClients).values({
    id: apiClientId,
    tenantId,
    servicePrincipalId,
    keyHash: apiKey.hash,
    keyPrefix: apiKey.prefixForLookup,
    scopes: [],
  });
  const ownerToken = `ses_${randomUUID()}`;
  const creatorToken = `ses_${randomUUID()}`;
  await db.insert(sessions).values([
    {
      id: newId('session'),
      userId: ownerUserId,
      tokenHash: hashToken(ownerToken),
      selectedTenantId: tenantId,
      expiresAt: new Date(Date.now() + 3600_000),
    },
    {
      id: newId('session'),
      userId: creatorUserId,
      tokenHash: hashToken(creatorToken),
      selectedTenantId: tenantId,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  ]);
  const extraIds: Record<string, string> = {};
  for (const ext of SEED_EXTENSIONS)
    Object.assign(extraIds, await ext(db, { tenantId, brandIds, ownerUserId }));
  const snapshot = async () => {
    const counts = await Promise.all(
      [
        memberships,
        brandGrants,
        servicePrincipals,
        apiClients,
        brands,
        auditEvents,
        outboxEvents,
        killSwitches,
        deletionRequests,
      ].map((t) =>
        db
          .select({ c: sql<number>`count(*)` })
          .from(t)
          .where(eq(t.tenantId, tenantId))
          .then((r) => Number(r[0]?.c ?? 0)),
      ),
    );
    const m = await db.select().from(memberships).where(eq(memberships.tenantId, tenantId));
    const sp = await db.select().from(servicePrincipals).where(eq(servicePrincipals.tenantId, tenantId));
    const ac = await db.select().from(apiClients).where(eq(apiClients.tenantId, tenantId));
    return JSON.stringify({ counts, m, sp, ac });
  };
  return {
    tenantId,
    ownerUserId,
    ownerToken,
    ownerMembershipId,
    creatorUserId,
    creatorToken,
    creatorMembershipId,
    brandIds,
    servicePrincipalId,
    apiClientId,
    apiClientKey: apiKey.token,
    ids: {
      tenantId,
      membershipId: creatorMembershipId,
      brandId: brandIds[0],
      brandId2: brandIds[1],
      servicePrincipalId,
      apiClientId,
      userId: creatorUserId,
    },
    snapshot,
  };
}

export async function seedTwoTenants(db: Db): Promise<{ tenantA: SeededTenant; tenantB: SeededTenant }> {
  composeModules();
  return { tenantA: await seedTenant(db, 'a'), tenantB: await seedTenant(db, 'b') };
}

export interface CallOptions {
  bearer: string;
  tenantId?: string;
  idempotencyKey?: string;
  correlationId?: string;
}

/** In-process caller with the same context builder as HTTP (headers → context). */
export async function callerFor(opts: CallOptions) {
  const headers: IncomingHttpHeaders = {
    authorization: `Bearer ${opts.bearer}`,
    'idempotency-key': opts.idempotencyKey ?? randomUUID(),
    'x-correlation-id': opts.correlationId ?? `test-${randomUUID()}`,
  };
  if (opts.tenantId) headers['x-oremedia-tenant'] = opts.tenantId;
  const ctx = await createContext(headers);
  return appRouter.createCaller(ctx);
}

/** Calls a procedure by dotted path with the given input; returns either the data or the error envelope. */
export async function callPath(
  opts: CallOptions,
  path: string,
  input: unknown,
): Promise<{ data?: unknown; error?: ErrorEnvelope }> {
  const caller = await callerFor(opts);
  const fn = path.split('.').reduce<unknown>((acc, seg) => (acc as Record<string, unknown>)[seg], caller) as (
    i: unknown,
  ) => Promise<unknown>;
  try {
    return { data: await fn(input) };
  } catch (err) {
    if (err instanceof TRPCError) return { error: envelopeFor(err, opts.correlationId ?? 'test') };
    throw err;
  }
}

export { runInTenant };
