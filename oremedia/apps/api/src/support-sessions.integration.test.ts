import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ID_PREFIXES, type IdKind } from '@oremedia/contracts/ids';
import { and, eq } from 'drizzle-orm';
import { sessions, supportSessions, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { auditEvents } from '@oremedia/db/schema/operations';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { accessService, hashToken } from '@oremedia/module-access';
// Relative import: a workspace dependency here would create an api ↔ test-fixtures cycle (test-fixtures imports the router).
import { callPath, seedTwoTenants, type SeededTenant } from '../../../tooling/test-fixtures/src';
import { configureRateLimiter } from './trpc';

/** Prefixed ids without the domain package (apps depend on contracts, not domain). */
const newId = (kind: IdKind) =>
  `${ID_PREFIXES[kind]}_${randomUUID().replace(/-/g, '').slice(0, 26).toUpperCase()}`;
/**
 * Spec 5.7 / spec 18 (platform operator → tenant data): support sessions instead of impersonation. Every request
 * made inside a support session, read or write, allowed or denied, leaves an audit row carrying its
 * supportSessionId; a session is read-only until a second operator escalates it (time-boxed, audited, never the
 * opener); an expired session reads nothing; a session is bound to its tenant.
 */
describe('support sessions: second-operator escalation and audit completeness (spec 5.7)', () => {
  let tdb: TestDatabase;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;
  const operators: Array<{ userId: string; tokenPart: string }> = [];

  /** An operator is a user with a session; a support bearer binds that session to one support session id. */
  const newOperator = async () => {
    const userId = newId('user');
    const tokenPart = randomUUID();
    await tdb.db
      .insert(users)
      .values({ id: userId, email: `${userId.toLowerCase()}@ops.example.test`, name: 'op' });
    await tdb.db.insert(sessions).values({
      id: newId('session'),
      userId,
      tokenHash: hashToken(`ses_${tokenPart}`),
      selectedTenantId: null,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const op = { userId, tokenPart };
    operators.push(op);
    return op;
  };
  const open = async (op: { userId: string; tokenPart: string }, tenantId: string) => {
    const { supportSessionId } = await accessService.openSupportSession(
      op.userId,
      {
        tenantId,
        reason: 'customer reported a missing brand',
        ticketRef: 'SUP-1234',
        consentRecorded: true,
        durationMinutes: 60,
      },
      `corr-${randomUUID()}`,
    );
    return { supportSessionId, bearer: `sup_${op.tokenPart}.${supportSessionId}` };
  };
  const operatorAudit = (tenantId: string) =>
    tdb.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.actorKind, 'platform_operator')));
  const sessionRow = async (id: string) =>
    (await tdb.db.select().from(supportSessions).where(eq(supportSessions.id, id)))[0]!;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    configureRateLimiter();
    ({ tenantA, tenantB } = await seedTwoTenants(tdb.db));
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('a read-only session reads, cannot write, cannot escalate itself; a second operator escalates; every request is audited with its supportSessionId', async () => {
    const op1 = await newOperator();
    const op2 = await newOperator();
    const s1 = await open(op1, tenantA.tenantId);
    const calls: Array<{ bearer: string; supportSessionId: string; path: string; ok: boolean }> = [];
    const call = async (s: { bearer: string; supportSessionId: string }, path: string, input: unknown) => {
      const res = await callPath({ bearer: s.bearer, tenantId: tenantA.tenantId }, path, input);
      calls.push({ ...s, path, ok: !res.error });
      return res;
    };

    // Reads: a procedure that consults policy and one that does not.
    expect((await call(s1, 'brand.list', undefined)).error).toBeUndefined();
    expect((await call(s1, 'brand.get', { brandId: tenantA.brandIds[0] })).error).toBeUndefined();
    expect((await call(s1, 'access.me', undefined)).error).toBeUndefined();

    // A write before escalation: refused by policy, nothing written.
    const brandCount = async () =>
      (await tdb.db.select().from(brands).where(eq(brands.tenantId, tenantA.tenantId))).length;
    const brandsBefore = await brandCount();
    const write = await call(s1, 'brand.create', {
      name: 'Operator brand',
      timezone: 'UTC',
      defaultLocale: 'en',
    });
    expect(write.error).toMatchObject({ code: 'FORBIDDEN' });
    expect(await brandCount()).toBe(brandsBefore);

    // The opener cannot escalate their own session; a tenant member (not an operator) cannot either.
    const self = await call(s1, 'access.supportSessions.escalate', {
      supportSessionId: s1.supportSessionId,
      reason: 'I need write access to fix it',
    });
    expect(self.error).toMatchObject({ code: 'FORBIDDEN' });
    const member = await callPath(
      { bearer: tenantA.ownerToken, tenantId: tenantA.tenantId },
      'access.supportSessions.escalate',
      { supportSessionId: s1.supportSessionId, reason: 'owner tries to escalate' },
    );
    expect(member.error).toMatchObject({ code: 'FORBIDDEN' });
    expect(await sessionRow(s1.supportSessionId)).toMatchObject({
      mode: 'read_only',
      escalatedByOperatorId: null,
    });

    // A second operator, inside their own session on the same tenant, escalates: time-boxed and audited.
    const s2 = await open(op2, tenantA.tenantId);
    const openedExpiry = (await sessionRow(s1.supportSessionId)).expiresAt.getTime();
    const before = Date.now();
    const escalated = await call(s2, 'access.supportSessions.escalate', {
      supportSessionId: s1.supportSessionId,
      reason: 'second operator approves the data fix in SUP-1234',
      durationMinutes: 15,
    });
    expect(escalated.error).toBeUndefined();
    const row = await sessionRow(s1.supportSessionId);
    expect(row).toMatchObject({ mode: 'escalated', escalatedByOperatorId: op2.userId });
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Math.min(openedExpiry, Date.now() + 15 * 60_000));
    expect(row.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 15 * 60_000 - 5_000);
    const again = await call(s2, 'access.supportSessions.escalate', {
      supportSessionId: s1.supportSessionId,
      reason: 'escalating a second time',
    });
    expect(again.error).toMatchObject({ code: 'VALIDATION_FAILED' });

    // The escalated session writes; never-actions stay denied by policy (support_never), unchanged here.
    const allowed = await call(s1, 'brand.create', {
      name: 'Operator brand',
      timezone: 'UTC',
      defaultLocale: 'en',
    });
    expect(allowed.error).toBeUndefined();
    expect(await brandCount()).toBe(brandsBefore + 1);

    // Audit completeness: every request of either session has its own support.request row, with its session id
    // and outcome; every operator row in the tenant carries the supportSessionId of that operator's session.
    const rows = await operatorAudit(tenantA.tenantId);
    for (const c of calls) {
      const match = rows.filter(
        (r) =>
          r.action === 'support.request' &&
          r.supportSessionId === c.supportSessionId &&
          (r.metadata as { path?: string } | null)?.path === c.path &&
          r.decision === (c.ok ? 'allowed' : 'denied'),
      );
      expect(match.length, `${c.path} (${c.ok ? 'ok' : 'denied'})`).toBeGreaterThanOrEqual(1);
    }
    expect(rows.filter((r) => r.action === 'support.request')).toHaveLength(calls.length);
    const sessionOf = new Map([
      [op1.userId, s1.supportSessionId],
      [op2.userId, s2.supportSessionId],
    ]);
    for (const r of rows)
      expect(r.supportSessionId, `${r.action} by ${r.actorId}`).toBe(sessionOf.get(r.actorId));
    // The policy decisions and domain events inside the requests are among them, with the session id.
    const actions = (id: string) =>
      rows.filter((r) => r.supportSessionId === id).map((r) => `${r.action}:${r.decision}`);
    expect(actions(s1.supportSessionId)).toEqual(
      expect.arrayContaining([
        'support.open:allowed',
        'brand.read:allowed',
        'brand.edit_standards:denied',
        'support.escalate:denied',
        'brand.edit_standards:allowed',
      ]),
    );
    expect(actions(s2.supportSessionId)).toEqual(
      expect.arrayContaining(['support.open:allowed', 'support.escalate:allowed']),
    );
    expect(rows.find((r) => r.action === 'support.escalate' && r.decision === 'allowed')).toMatchObject({
      resourceId: s1.supportSessionId,
      supportSessionId: s2.supportSessionId,
    });
  });

  it('an expired session reads nothing and the refused request is still audited', async () => {
    const op = await newOperator();
    const s = await open(op, tenantA.tenantId);
    await tdb.db
      .update(supportSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(supportSessions.id, s.supportSessionId));
    for (const path of ['access.me', 'brand.list']) {
      const res = await callPath({ bearer: s.bearer, tenantId: tenantA.tenantId }, path, undefined);
      expect(res.error, path).toMatchObject({ code: 'FORBIDDEN' });
    }
    const rows = (await operatorAudit(tenantA.tenantId)).filter(
      (r) => r.supportSessionId === s.supportSessionId,
    );
    expect(
      rows
        .filter((r) => r.action === 'support.request')
        .map((r) => [(r.metadata as { path?: string }).path, r.decision, r.reason]),
    ).toEqual(
      expect.arrayContaining([
        ['access.me', 'denied', 'support_session_expired'],
        ['brand.list', 'denied', 'support_session_expired'],
      ]),
    );
  });

  it('a session is bound to its tenant: another tenant is refused, a foreign session id is NOT_FOUND to escalate', async () => {
    const opA = await newOperator();
    const opB = await newOperator();
    const sA = await open(opA, tenantA.tenantId);
    const sB = await open(opB, tenantB.tenantId);
    const other = await callPath({ bearer: sB.bearer, tenantId: tenantA.tenantId }, 'brand.list', undefined);
    expect(other.error).toMatchObject({ code: 'FORBIDDEN' });
    const foreign = await callPath(
      { bearer: sB.bearer, tenantId: tenantB.tenantId },
      'access.supportSessions.escalate',
      { supportSessionId: sA.supportSessionId, reason: 'escalate a session of another tenant' },
    );
    expect(foreign.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(await sessionRow(sA.supportSessionId)).toMatchObject({ mode: 'read_only' });
    // The refused cross-tenant attempt is audited in the session's own tenant, never in the target tenant.
    expect(
      (await operatorAudit(tenantB.tenantId)).some(
        (r) => r.action === 'support.request' && r.decision === 'denied' && r.reason === 'tenant_mismatch',
      ),
    ).toBe(true);
    expect((await operatorAudit(tenantA.tenantId)).some((r) => r.actorId === opB.userId)).toBe(false);
  });
});
