import {
  boolean,
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { ServicePrincipalGrant } from '@oremedia/contracts/policy';
import { createdAt, hash, id, ref, tenantId, ts, updatedAt, version } from './_columns';

/** Global: identities span tenants. Listed in GLOBAL_TABLES. */
export const users = mysqlTable(
  'users',
  {
    id: id(),
    email: varchar('email', { length: 320 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    locale: varchar('locale', { length: 16 }).notNull().default('en'),
    status: mysqlEnum('status', ['active', 'disabled', 'deleted']).notNull().default('active'),
    mfaEnrolled: boolean('mfa_enrolled').notNull().default(false),
    passwordHash: varchar('password_hash', { length: 255 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('uq_users_email').on(t.email)],
);

/** Global: the tenant row itself. Listed in GLOBAL_TABLES. */
export const tenants = mysqlTable(
  'tenants',
  {
    id: id(),
    name: varchar('name', { length: 200 }).notNull(),
    slug: varchar('slug', { length: 80 }).notNull(),
    billingAccountId: ref('billing_account_id'),
    dataRegion: varchar('data_region', { length: 16 }).notNull().default('default'),
    status: mysqlEnum('status', ['active', 'suspended', 'closing']).notNull().default('active'),
    policy: json('policy').$type<{
      maxAutonomy?: string;
      mfaRequired?: boolean;
      requireDistinctApprover?: boolean;
    }>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('uq_tenants_slug').on(t.slug)],
);

export const memberships = mysqlTable(
  'memberships',
  {
    id: id(),
    tenantId: tenantId(),
    userId: ref('user_id').notNull(),
    role: mysqlEnum('role', [
      'owner',
      'admin',
      'brand_manager',
      'creator',
      'reviewer',
      'publisher',
      'analyst',
      'community',
    ]).notNull(),
    status: mysqlEnum('status', ['invited', 'active', 'disabled']).notNull(),
    allBrands: boolean('all_brands').notNull().default(false),
    invitedEmail: varchar('invited_email', { length: 320 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_membership').on(t.tenantId, t.userId),
    uniqueIndex('uq_membership_ti').on(t.tenantId, t.id),
    index('ix_membership_user').on(t.userId),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id], name: 'fk_membership_tenant' }),
    foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: 'fk_membership_user' }),
  ],
);

export const brandGrants = mysqlTable(
  'brand_grants',
  {
    id: id(),
    tenantId: tenantId(),
    membershipId: ref('membership_id').notNull(),
    brandId: ref('brand_id').notNull(),
    roles: json('roles').$type<string[]>().notNull(), // additional per-brand roles
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_brand_grant').on(t.tenantId, t.membershipId, t.brandId),
    foreignKey({
      columns: [t.tenantId, t.membershipId],
      foreignColumns: [memberships.tenantId, memberships.id],
      name: 'fk_brand_grant_membership',
    }),
  ],
);

export const servicePrincipals = mysqlTable(
  'service_principals',
  {
    id: id(),
    tenantId: tenantId(),
    kind: mysqlEnum('kind', ['agent', 'api_client', 'mcp_client', 'integration']).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    grants: json('grants').$type<ServicePrincipalGrant[]>().notNull(), // action + brand + channel scope
    maxAutonomy: mysqlEnum('max_autonomy', ['assist', 'create', 'prepare_release', 'managed_autopublish'])
      .notNull()
      .default('create'),
    status: mysqlEnum('status', ['active', 'revoked']).notNull(),
    createdByUserId: ref('created_by_user_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_service_principal_ti').on(t.tenantId, t.id),
    foreignKey({ columns: [t.tenantId], foreignColumns: [tenants.id], name: 'fk_sp_tenant' }),
  ],
);

export const apiClients = mysqlTable(
  'api_clients',
  {
    id: id(),
    tenantId: tenantId(),
    servicePrincipalId: ref('service_principal_id').notNull(),
    keyHash: hash('key_hash').notNull(),
    keyPrefix: varchar('key_prefix', { length: 12 }).notNull(),
    scopes: json('scopes').$type<string[]>().notNull(),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    status: mysqlEnum('status', ['active', 'revoked']).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_api_client_key').on(t.keyHash),
    index('ix_api_client_prefix').on(t.keyPrefix),
    foreignKey({
      columns: [t.tenantId, t.servicePrincipalId],
      foreignColumns: [servicePrincipals.tenantId, servicePrincipals.id],
      name: 'fk_api_client_sp',
    }),
  ],
);

/** Global: a session belongs to a user and carries the *selected* tenant as a hint, verified per request. */
export const sessions = mysqlTable(
  'sessions',
  {
    id: id(),
    userId: ref('user_id').notNull(),
    tokenHash: hash('token_hash').notNull(),
    selectedTenantId: ref('selected_tenant_id'),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    ipHash: varchar('ip_hash', { length: 64 }),
    userAgentHash: varchar('user_agent_hash', { length: 64 }),
    createdAt: createdAt(),
    lastSeenAt: ts('last_seen_at'),
  },
  (t) => [
    uniqueIndex('uq_session_token').on(t.tokenHash),
    index('ix_session_user').on(t.userId),
    foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: 'fk_session_user' }),
  ],
);

export const externalReviewerLinks = mysqlTable(
  'external_reviewer_links',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: ref('brand_id').notNull(),
    reviewRequestId: ref('review_request_id').notNull(),
    tokenHash: hash('token_hash').notNull(),
    email: varchar('email', { length: 320 }).notNull(),
    emailVerifiedAt: ts('email_verified_at'),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    lastUsedAt: ts('last_used_at'),
    createdByUserId: ref('created_by_user_id').notNull(),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_reviewer_link_token').on(t.tokenHash),
    index('ix_reviewer_link_request').on(t.tenantId, t.reviewRequestId),
  ],
);

/** Platform: audited operator access to one tenant (spec 5.7). */
export const supportSessions = mysqlTable(
  'support_sessions',
  {
    id: id(),
    operatorId: ref('operator_id').notNull(),
    tenantId: tenantId(),
    reason: text('reason').notNull(),
    ticketRef: varchar('ticket_ref', { length: 80 }).notNull(),
    consentRecorded: boolean('consent_recorded').notNull().default(false),
    mode: mysqlEnum('mode', ['read_only', 'escalated']).notNull().default('read_only'),
    escalatedByOperatorId: ref('escalated_by_operator_id'),
    expiresAt: ts('expires_at').notNull(),
    closedAt: ts('closed_at'),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [index('ix_support_session_tenant').on(t.tenantId, t.expiresAt)],
);
