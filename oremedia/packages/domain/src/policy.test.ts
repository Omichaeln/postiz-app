import { describe, expect, it } from 'vitest';
import type { Action, EntitlementSet, PolicyContext, ResolvedActor } from '@oremedia/contracts/policy';
import { ENTITLEMENT_GATED_ACTIONS, authorize } from './policy';
import { DEFAULT_ROLE_GRANTS, AGENT_NEVER } from './role-grants';

const T = 'ten_A';
const B = 'brd_1';
const ent: EntitlementSet = {
  limits: { channels: 3, seats: 10, generation_budget_micros_month: 1_000_000 },
  features: { experiments: true, managed_autopublish: false },
  usage: { channels: 1, seats: 2 },
};
const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  entitlements: ent,
  now: new Date('2026-09-23T00:00:00Z'),
  ...over,
});

const user = (over: Partial<Extract<ResolvedActor, { kind: 'user' }>> = {}): ResolvedActor => ({
  kind: 'user',
  id: 'usr_1',
  tenantId: T,
  membershipId: 'mem_1',
  membershipStatus: 'active',
  role: 'creator',
  allBrands: false,
  brandGrants: [{ brandId: B, roles: [] }],
  mfaEnrolled: false,
  ...over,
});

const agent = (over: Partial<Extract<ResolvedActor, { kind: 'service_principal' }>> = {}): ResolvedActor => ({
  kind: 'service_principal',
  id: 'sp_1',
  tenantId: T,
  status: 'active',
  maxAutonomy: 'create',
  grants: [
    { action: 'creative.edit', brandIds: [B] },
    { action: 'brand.read', brandIds: 'all' },
    { action: 'publication.schedule', brandIds: [B], channelConnectionIds: ['cc_1'] },
  ],
  ...over,
});

describe('authorize: ordered checks (spec 5.5)', () => {
  it('1. tenant mismatch is denied before anything else', () => {
    expect(
      authorize({
        actor: user({ role: 'owner', allBrands: true }),
        action: 'brand.read',
        resource: { type: 'brand', tenantId: 'ten_B', brandId: B },
        context: ctx(),
      }),
    ).toEqual({ allowed: false, reason: 'tenant_mismatch' });
  });
  it('2. inactive membership is denied', () => {
    expect(
      authorize({
        actor: user({ membershipStatus: 'invited' }),
        action: 'brand.read',
        resource: { type: 'brand', tenantId: T, brandId: B },
        context: ctx(),
      }).reason,
    ).toBe('membership_inactive');
    expect(
      authorize({
        actor: agent({ status: 'revoked' }),
        action: 'brand.read',
        resource: { type: 'brand', tenantId: T, brandId: B },
        context: ctx({ autonomyMode: 'create' }),
      }).reason,
    ).toBe('principal_revoked');
  });
  it('2b. tenant MFA policy', () => {
    expect(
      authorize({
        actor: user(),
        action: 'brand.read',
        resource: { type: 'brand', tenantId: T, brandId: B },
        context: ctx({ mfaRequired: true }),
      }).reason,
    ).toBe('mfa_required');
  });
  it('3. brand not granted', () => {
    expect(
      authorize({
        actor: user(),
        action: 'brand.read',
        resource: { type: 'brand', tenantId: T, brandId: 'brd_2' },
        context: ctx(),
      }).reason,
    ).toBe('brand_not_granted');
    expect(
      authorize({
        actor: user({ allBrands: true }),
        action: 'brand.read',
        resource: { type: 'brand', tenantId: T, brandId: 'brd_2' },
        context: ctx(),
      }).allowed,
    ).toBe(true);
  });
  it('4. role missing', () => {
    expect(
      authorize({
        actor: user({ role: 'creator' }),
        action: 'review.decide',
        resource: { type: 'review_request', tenantId: T, brandId: B, state: 'open' },
        context: ctx(),
      }).reason,
    ).toBe('role_missing');
    expect(
      authorize({
        actor: user({ role: 'reviewer' }),
        action: 'review.decide',
        resource: { type: 'review_request', tenantId: T, brandId: B, state: 'open' },
        context: ctx(),
      }).allowed,
    ).toBe(true);
  });
  it('4b. per-brand roles extend the membership role only on that brand', () => {
    const a = user({
      role: 'creator',
      brandGrants: [
        { brandId: B, roles: ['reviewer'] },
        { brandId: 'brd_2', roles: [] },
      ],
    });
    expect(
      authorize({
        actor: a,
        action: 'review.decide',
        resource: { type: 'rr', tenantId: T, brandId: B, state: 'open' },
        context: ctx(),
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        actor: a,
        action: 'review.decide',
        resource: { type: 'rr', tenantId: T, brandId: 'brd_2', state: 'open' },
        context: ctx(),
      }).reason,
    ).toBe('role_missing');
  });
  it('5. resource state: cannot edit an approved revision', () => {
    expect(
      authorize({
        actor: user({ role: 'brand_manager' }),
        action: 'creative.edit',
        resource: { type: 'creative_document', tenantId: T, brandId: B, state: 'approved' },
        context: ctx(),
      }).reason,
    ).toBe('resource_state');
  });
  it('6. entitlement: channel limit reached', () => {
    const full: EntitlementSet = { ...ent, usage: { ...ent.usage, channels: 3 } };
    expect(
      authorize({
        actor: user({ role: 'owner', allBrands: true }),
        action: 'channel.connect',
        resource: { type: 'brand', tenantId: T, brandId: B },
        context: ctx({ entitlements: full }),
      }).reason,
    ).toBe('entitlement_exceeded');
    expect(
      authorize({
        actor: user({ role: 'owner', allBrands: true }),
        action: 'mandate.manage',
        resource: { type: 'brand', tenantId: T, brandId: B },
        context: ctx(),
      }).reason,
    ).toBe('entitlement_exceeded');
  });
  it('7. agents: never actions, grant ∩ autonomy, channel scope', () => {
    for (const a of AGENT_NEVER) {
      const d = authorize({
        actor: agent({ grants: [{ action: a as Action, brandIds: 'all' }] }),
        action: a as Action,
        resource: { type: 'x', tenantId: T, brandId: B },
        context: ctx({ autonomyMode: 'create' }),
      });
      expect(d.allowed, a).toBe(false);
    }
    expect(
      authorize({
        actor: agent(),
        action: 'creative.edit',
        resource: { type: 'doc', tenantId: T, brandId: B },
        context: ctx({ autonomyMode: 'create' }),
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        actor: agent(),
        action: 'creative.edit',
        resource: { type: 'doc', tenantId: T, brandId: B },
        context: ctx({ autonomyMode: 'assist' }),
      }).reason,
    ).toBe('autonomy_insufficient');
    expect(
      authorize({
        actor: agent(),
        action: 'creative.edit',
        resource: { type: 'doc', tenantId: T, brandId: B },
        context: ctx({ autonomyMode: 'prepare_release' }),
      }).reason,
    ).toBe('autonomy_exceeds_principal');
    // A direct API call carries its per-request ceiling; an explicit run mode still wins over it.
    expect(
      authorize({
        actor: agent({ requestAutonomy: 'create' }),
        action: 'creative.edit',
        resource: { type: 'doc', tenantId: T, brandId: B },
        context: ctx({}),
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        actor: agent({ requestAutonomy: 'create' }),
        action: 'creative.edit',
        resource: { type: 'doc', tenantId: T, brandId: B },
        context: ctx({ autonomyMode: 'assist' }),
      }).reason,
    ).toBe('autonomy_insufficient');
    expect(
      authorize({
        actor: agent(),
        action: 'creative.edit',
        resource: { type: 'doc', tenantId: T, brandId: B },
        context: ctx({}),
      }).reason,
    ).toBe('autonomy_insufficient');
    expect(
      authorize({
        actor: agent({ maxAutonomy: 'prepare_release' }),
        action: 'publication.schedule',
        resource: { type: 'variant', tenantId: T, brandId: B, channelId: 'cc_2' },
        context: ctx({ autonomyMode: 'prepare_release' }),
      }).reason,
    ).toBe('channel_not_granted');
    const d = authorize({
      actor: agent({ maxAutonomy: 'prepare_release' }),
      action: 'publication.schedule',
      resource: { type: 'variant', tenantId: T, brandId: B, channelId: 'cc_1' },
      context: ctx({ autonomyMode: 'prepare_release' }),
    });
    expect(d.allowed).toBe(true);
    expect(d.obligations).toEqual(
      expect.arrayContaining([{ type: 'propose_only' }, { type: 'requires_approval', scope: 'publication' }]),
    );
  });
  it('7b. an agent cannot raise its own mode: requested above principal max is denied', () => {
    expect(
      authorize({
        actor: agent({ maxAutonomy: 'create' }),
        action: 'brand.read',
        resource: { type: 'brand', tenantId: T, brandId: B },
        context: ctx({ autonomyMode: 'managed_autopublish' }),
      }).reason,
    ).toBe('autonomy_exceeds_principal');
  });
  it('8. separation of duties when the tenant requires a distinct approver', () => {
    const a = user({ id: 'usr_9', role: 'brand_manager' });
    expect(
      authorize({
        actor: a,
        action: 'review.decide',
        resource: { type: 'rr', tenantId: T, brandId: B, state: 'open', authorPrincipalId: 'usr_9' },
        context: ctx({ requireDistinctApprover: true }),
      }).reason,
    ).toBe('distinct_approver_required');
    expect(
      authorize({
        actor: a,
        action: 'review.decide',
        resource: { type: 'rr', tenantId: T, brandId: B, state: 'open', authorPrincipalId: 'usr_9' },
        context: ctx({ requireDistinctApprover: false }),
      }).allowed,
    ).toBe(true);
  });
  it('external reviewer: only review.decide on its own request', () => {
    const r: ResolvedActor = {
      kind: 'external_reviewer',
      id: 'erl_1',
      tenantId: T,
      reviewRequestId: 'rr_1',
      brandId: B,
      revoked: false,
      expired: false,
    };
    expect(
      authorize({
        actor: r,
        action: 'review.decide',
        resource: { type: 'rr', tenantId: T, brandId: B, reviewRequestId: 'rr_1', state: 'open' },
        context: ctx(),
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        actor: r,
        action: 'review.decide',
        resource: { type: 'rr', tenantId: T, brandId: B, reviewRequestId: 'rr_2', state: 'open' },
        context: ctx(),
      }).reason,
    ).toBe('reviewer_wrong_request');
    expect(
      authorize({
        actor: r,
        action: 'creative.edit',
        resource: { type: 'doc', tenantId: T, brandId: B },
        context: ctx(),
      }).reason,
    ).toBe('reviewer_scope');
    expect(
      authorize({
        actor: { ...r, revoked: true },
        action: 'review.decide',
        resource: { type: 'rr', tenantId: T, brandId: B, reviewRequestId: 'rr_1' },
        context: ctx(),
      }).reason,
    ).toBe('reviewer_link_revoked');
  });
  it('platform operator: read-only unless escalated; never decides or publishes', () => {
    const op: ResolvedActor = {
      kind: 'platform_operator',
      id: 'usr_op',
      tenantId: T,
      supportSessionId: 'ss_1',
      mode: 'read_only',
      expired: false,
    };
    expect(
      authorize({
        actor: op,
        action: 'brand.read',
        resource: { type: 'brand', tenantId: T, brandId: B },
        context: ctx(),
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        actor: op,
        action: 'creative.edit',
        resource: { type: 'doc', tenantId: T, brandId: B },
        context: ctx(),
      }).reason,
    ).toBe('support_read_only');
    expect(
      authorize({
        actor: { ...op, mode: 'escalated' },
        action: 'creative.edit',
        resource: { type: 'doc', tenantId: T, brandId: B },
        context: ctx(),
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        actor: { ...op, mode: 'escalated' },
        action: 'publication.schedule',
        resource: { type: 'v', tenantId: T, brandId: B },
        context: ctx(),
      }).reason,
    ).toBe('support_never');
    expect(
      authorize({
        actor: { ...op, expired: true },
        action: 'brand.read',
        resource: { type: 'brand', tenantId: T, brandId: B },
        context: ctx(),
      }).reason,
    ).toBe('support_session_expired');
  });
  it('decision table: default role grants match spec 5.5 rows', () => {
    expect(DEFAULT_ROLE_GRANTS['channel.connect']).toEqual(['owner', 'admin', 'publisher']);
    expect(DEFAULT_ROLE_GRANTS['playbook.approve']).toEqual(['owner', 'admin', 'brand_manager']);
    expect(DEFAULT_ROLE_GRANTS['billing.manage']).toEqual(['owner', 'admin']);
    expect(DEFAULT_ROLE_GRANTS['inbox.respond']).toEqual(['owner', 'admin', 'brand_manager', 'community']);
    expect(DEFAULT_ROLE_GRANTS['experiment.manage']).toEqual(['owner', 'admin', 'brand_manager', 'analyst']);
    // skill.read follows brand.read: every role reads the registry; authoring and publishing stay narrower.
    expect(DEFAULT_ROLE_GRANTS['skill.read']).toEqual(DEFAULT_ROLE_GRANTS['brand.read']);
    expect(DEFAULT_ROLE_GRANTS['skill.author']).toEqual(['owner', 'admin', 'brand_manager']);
  });
  it('skill.read: a reader role, an agent with the grant (assist) and a read-only support session may read; without the grant an agent may not', () => {
    expect(
      authorize({
        actor: user({ role: 'analyst' }),
        action: 'skill.read',
        resource: { type: 'skill', tenantId: T, brandId: B },
        context: ctx(),
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        actor: user({ role: 'creator' }),
        action: 'skill.read',
        resource: { type: 'skill', tenantId: T, brandId: 'brd_other' },
        context: ctx(),
      }).reason,
    ).toBe('brand_not_granted');
    expect(
      authorize({
        actor: agent({ grants: [{ action: 'skill.read', brandIds: 'all' }] }),
        action: 'skill.read',
        resource: { type: 'skill', tenantId: T, brandId: B },
        context: ctx({ autonomyMode: 'assist' }),
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        actor: agent(),
        action: 'skill.read',
        resource: { type: 'skill', tenantId: T },
        context: ctx({ autonomyMode: 'assist' }),
      }).reason,
    ).toBe('grant_missing');
    expect(
      authorize({
        actor: {
          kind: 'platform_operator',
          id: 'usr_op',
          tenantId: T,
          supportSessionId: 'ss_1',
          mode: 'read_only',
          expired: false,
        },
        action: 'skill.read',
        resource: { type: 'skill', tenantId: T },
        context: ctx(),
      }).allowed,
    ).toBe(true);
  });
});

describe('entitlement gates (step 6)', () => {
  it('names exactly the actions whose decision reads entitlements', () => {
    expect([...ENTITLEMENT_GATED_ACTIONS].sort()).toEqual([
      'agent.start_run',
      'channel.connect',
      'experiment.manage',
      'mandate.manage',
      'membership.manage',
    ]);
  });
  it('a non-gated action decides without any entitlement data; a gated one needs it', () => {
    const none = { limits: {}, features: {}, usage: {} };
    expect(
      authorize({
        actor: user({ role: 'owner', allBrands: true }),
        action: 'brand.read',
        resource: { type: 'brand', tenantId: T, brandId: B },
        context: ctx({ entitlements: none }),
      }).allowed,
    ).toBe(true);
    expect(
      authorize({
        actor: user({ role: 'owner', allBrands: true }),
        action: 'membership.manage',
        resource: { type: 'tenant', tenantId: T },
        context: ctx({ entitlements: none }),
      }),
    ).toEqual({ allowed: false, reason: 'entitlement_exceeded' });
  });
});
