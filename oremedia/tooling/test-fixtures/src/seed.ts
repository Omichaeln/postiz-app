import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { TRPCError } from '@trpc/server';
import { eq, getTableColumns, getTableName, sql } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn } from 'drizzle-orm/mysql-core';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  appRouter,
  composeModules,
  createContext,
  envelopeFor,
} from '@oremedia/api';
import { runInTenant, type Db } from '@oremedia/db';
import * as schema from '@oremedia/db/schema';
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
import { newId } from '@oremedia/domain/ids';
import { hashToken, newOpaqueToken } from '@oremedia/module-access';
import type { ErrorEnvelope } from '@oremedia/contracts/errors';
import { SEED_EXTENSIONS } from './cross-tenant-inputs';

/**
 * Every table in the schema that carries a tenant_id column (the same detection as
 * tooling/scripts/check-schema-tenancy.ts), so the "no writes landed in tenant B" snapshot covers a table the day
 * it is added rather than a hand-kept list.
 */
const TENANT_TABLES: Array<[name: string, table: MySqlTable, tenantCol: MySqlColumn]> = Object.values(
  schema as Record<string, unknown>,
)
  .filter((v): v is MySqlTable => v instanceof MySqlTable)
  .flatMap((table) => {
    const tenantCol = Object.values(getTableColumns(table)).find((c) => c.name === 'tenant_id');
    return tenantCol ? [[getTableName(table), table, tenantCol] as [string, MySqlTable, MySqlColumn]] : [];
  });

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
    // Row count per tenant-scoped table, keyed by table name (in schema order, so the JSON is stable and a diff
    // names the table that received a write).
    const counts = Object.fromEntries(
      await Promise.all(
        TENANT_TABLES.map(([name, table, tenantCol]) =>
          db
            .select({ c: sql<number>`count(*)` })
            .from(table)
            .where(eq(tenantCol, tenantId))
            .then((r) => [name, Number(r[0]?.c ?? 0)] as const),
        ),
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
      ...extraIds,
    },
    snapshot,
  };
}

/**
 * An extra service principal with its own API client key (spec 7.6 per-key scopes), for tests of the public REST
 * API and the MCP server. The principal's grants decide what the policy engine allows; the scopes narrow the key.
 */
export async function seedApiClient(
  db: Db,
  tenant: Pick<SeededTenant, 'tenantId' | 'ownerUserId'>,
  opts: {
    grants: Array<{ action: string; brandIds: string[] | 'all' }>;
    scopes: string[];
    maxAutonomy?: 'assist' | 'create' | 'prepare_release' | 'managed_autopublish';
    kind?: 'agent' | 'api_client' | 'mcp_client' | 'integration';
  },
): Promise<{ servicePrincipalId: string; apiClientId: string; key: string }> {
  const servicePrincipalId = newId('servicePrincipal');
  const apiClientId = newId('apiClient');
  await db.insert(servicePrincipals).values({
    id: servicePrincipalId,
    tenantId: tenant.tenantId,
    kind: opts.kind ?? 'mcp_client',
    name: `client ${servicePrincipalId.slice(-6)}`,
    grants: opts.grants as (typeof servicePrincipals.$inferInsert)['grants'],
    maxAutonomy: opts.maxAutonomy ?? 'create',
    status: 'active',
    createdByUserId: tenant.ownerUserId,
  });
  const key = newOpaqueToken('ak');
  await db.insert(apiClients).values({
    id: apiClientId,
    tenantId: tenant.tenantId,
    servicePrincipalId,
    keyHash: key.hash,
    keyPrefix: key.prefixForLookup,
    scopes: opts.scopes,
  });
  return { servicePrincipalId, apiClientId, key: key.token };
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
  /**
   * Present the credential as a browser cookie session instead of a bearer header. `csrf` is the double-submit
   * header value; the cookie always carries the token, so omitting `csrf` models a request without the header.
   */
  cookieSession?: { csrf?: string };
}

export const CSRF_TOKEN = 'csrf-test-token';

/** The headers an HTTP request with these options carries. */
export function headersFor(opts: CallOptions): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {
    'idempotency-key': opts.idempotencyKey ?? randomUUID(),
    'x-correlation-id': opts.correlationId ?? `test-${randomUUID()}`,
  };
  if (opts.cookieSession) {
    headers['cookie'] = `${SESSION_COOKIE}=${opts.bearer}; ${CSRF_COOKIE}=${CSRF_TOKEN}`;
    if (opts.cookieSession.csrf) headers['x-oremedia-csrf'] = opts.cookieSession.csrf;
  } else headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.tenantId) headers['x-oremedia-tenant'] = opts.tenantId;
  return headers;
}

/** The request context an HTTP request with these options would get (headers → context). */
export async function contextFor(opts: CallOptions) {
  return createContext(headersFor(opts));
}

/** In-process caller with the same context builder as HTTP. */
export async function callerFor(opts: CallOptions) {
  return appRouter.createCaller(await contextFor(opts));
}

/** Calls a procedure by dotted path with the given input; returns either the data or the error envelope. */
export async function callPath(
  opts: CallOptions,
  path: string,
  input: unknown,
): Promise<{ data?: unknown; error?: ErrorEnvelope; trpcCode?: string }> {
  const ctx = await contextFor(opts);
  const caller = appRouter.createCaller(ctx);
  const fn = path.split('.').reduce<unknown>((acc, seg) => (acc as Record<string, unknown>)[seg], caller) as (
    i: unknown,
  ) => Promise<unknown>;
  try {
    return { data: await fn(input) };
  } catch (err) {
    if (err instanceof TRPCError) return { error: envelopeFor(err, ctx.correlationId), trpcCode: err.code };
    throw err;
  }
}

export { runInTenant };
