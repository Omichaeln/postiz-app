import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { IdempotencyKeyReusedError, IdempotencyInProgressError } from '@oremedia/contracts/errors';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { auditEvents, outboxEvents, idempotencyKeys, killSwitches } from '@oremedia/db/schema/operations';
import { newId } from '@oremedia/domain/ids';
import { idempotent, IN_PROGRESS_LEASE_MS } from './idempotent';
import { outbox } from './outbox';
import { audit } from './audit';
import { killSwitch } from './kill-switch';
import { evaluateFlag, FLAG_DEFINITIONS } from './feature-flags';

const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: 'usr_1' },
  brandIds: 'all',
  correlationId: 'corr_ops',
});

describe('operations module against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'ops-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'ops-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  describe('idempotent()', () => {
    const mctx = (key: string, hash: string, path = 'test.create') => ({
      idempotency: { key, path, requestHash: hash },
      actor: { kind: 'user', id: 'usr_1' },
    });

    it('same key + same hash replays the stored response without re-running the command', async () => {
      let runs = 0;
      const cmd = async () => {
        runs++;
        return { id: newId('brand'), ok: true };
      };
      const first = await runInTenant(ctx(tenantA), () => idempotent(mctx('k1', 'h1'), cmd));
      const second = await runInTenant(ctx(tenantA), () => idempotent(mctx('k1', 'h1'), cmd));
      expect(second).toEqual(first);
      expect(runs).toBe(1);
    });

    it('same key + different hash → IDEMPOTENCY_KEY_REUSED', async () => {
      await runInTenant(ctx(tenantA), () => idempotent(mctx('k2', 'h1'), async () => 1));
      await expect(
        runInTenant(ctx(tenantA), () => idempotent(mctx('k2', 'h2'), async () => 2)),
      ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    });

    it('key scope is (tenant, principal, key): another tenant with the same key runs its own command', async () => {
      const a = await runInTenant(ctx(tenantA), () => idempotent(mctx('k3', 'h1'), async () => 'A'));
      const b = await runInTenant(ctx(tenantB), () => idempotent(mctx('k3', 'h1'), async () => 'B'));
      expect(a).toBe('A');
      expect(b).toBe('B');
    });

    it('the idempotency row, domain write, audit and outbox event commit or roll back together', async () => {
      const brandId = newId('brand');
      await expect(
        runInTenant(ctx(tenantA), () =>
          idempotent(mctx('k4', 'h1'), async (tx) => {
            await tx.insert(brands).values({
              id: brandId,
              tenantId: tenantA,
              name: 'Atomic',
              timezone: 'UTC',
              defaultLocale: 'en',
              status: 'setup',
            });
            await audit.record(
              { kind: 'user', id: 'usr_1' },
              'brand.create',
              { type: 'brand', id: brandId },
              'allowed',
              tx,
            );
            await outbox.add('tenant.created', { type: 'brand', id: brandId, version: 0 }, { brandId }, tx);
            throw new Error('boom');
          }),
        ),
      ).rejects.toThrow('boom');
      expect((await tdb.db.select().from(brands).where(eq(brands.id, brandId))).length).toBe(0);
      expect(
        (await tdb.db.select().from(auditEvents).where(eq(auditEvents.resourceId, brandId))).length,
      ).toBe(0);
      expect(
        (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, brandId))).length,
      ).toBe(0);
      expect((await tdb.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, 'k4'))).length).toBe(
        0,
      );
    });

    it('a concurrent duplicate gets 409 in-progress, then a replay once the first completes', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow = runInTenant(ctx(tenantA), () =>
        idempotent(mctx('k5', 'h1'), async () => {
          await gate;
          return 'done';
        }),
      );
      await new Promise((r) => setTimeout(r, 100));
      await expect(
        runInTenant(ctx(tenantA), () => idempotent(mctx('k5', 'h1'), async () => 'dup')),
      ).rejects.toBeInstanceOf(IdempotencyInProgressError);
      release();
      expect(await slow).toBe('done');
      expect(await runInTenant(ctx(tenantA), () => idempotent(mctx('k5', 'h1'), async () => 'dup'))).toBe(
        'done',
      );
    });

    it('an in_progress marker is a short lease; an abandoned one is taken over, a live one still conflicts', async () => {
      const row = (key: string) =>
        tdb.db
          .select()
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, key))
          .then((r) => r[0]!);
      // While the command runs, the marker expires within the lease, not the record's TTL.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const running = runInTenant(ctx(tenantA), () =>
        idempotent(mctx('k6', 'h1'), async () => {
          await gate;
          return 'first';
        }),
      );
      await new Promise((r) => setTimeout(r, 100));
      expect((await row('k6')).expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(IN_PROGRESS_LEASE_MS);
      release();
      expect(await running).toBe('first');
      expect((await row('k6')).expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3600 * 1000);

      // A marker whose lease has expired (crash between marker and command) is taken over by the same request.
      await tdb.db.insert(idempotencyKeys).values({
        tenantId: tenantA,
        principalId: 'usr_1',
        key: 'k7',
        path: 'test.create',
        requestHash: 'h1',
        state: 'in_progress',
        expiresAt: new Date(Date.now() - 1000),
      });
      expect(await runInTenant(ctx(tenantA), () => idempotent(mctx('k7', 'h1'), async () => 'retry'))).toBe(
        'retry',
      );
      expect((await row('k7')).state).toBe('completed');
      expect(await runInTenant(ctx(tenantA), () => idempotent(mctx('k7', 'h1'), async () => 'again'))).toBe(
        'retry',
      );

      // A live marker still means "in progress".
      await tdb.db.insert(idempotencyKeys).values({
        tenantId: tenantA,
        principalId: 'usr_1',
        key: 'k8',
        path: 'test.create',
        requestHash: 'h1',
        state: 'in_progress',
        expiresAt: new Date(Date.now() + IN_PROGRESS_LEASE_MS),
      });
      await expect(
        runInTenant(ctx(tenantA), () => idempotent(mctx('k8', 'h1'), async () => 'dup')),
      ).rejects.toBeInstanceOf(IdempotencyInProgressError);
      // A different request under a live key is still a reuse, whatever the state.
      await expect(
        runInTenant(ctx(tenantA), () => idempotent(mctx('k8', 'h2'), async () => 'dup')),
      ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    });
  });

  describe('outbox and audit', () => {
    it('outbox.add stamps tenant, correlation and schema version; payload refs only', async () => {
      const id = await runInTenant(ctx(tenantA), () =>
        withTransaction((tx) =>
          outbox.add(
            'publication.scheduled',
            { type: 'publication', id: 'pub_x', version: 1 },
            { publicationId: 'pub_x' },
            tx,
          ),
        ),
      );
      const row = (await tdb.db.select().from(outboxEvents).where(eq(outboxEvents.id, id)))[0]!;
      expect(row.tenantId).toBe(tenantA);
      expect(row.correlationId).toBe('corr_ops');
      expect(row.schemaVersion).toBe(1);
      expect(row.dispatchedAt).toBeNull();
      await expect(
        runInTenant(ctx(tenantA), () =>
          withTransaction((tx) =>
            outbox.add(
              'publication.scheduled',
              { type: 'publication', id: 'pub_x', version: 1 },
              { blob: 'x'.repeat(600) },
              tx,
            ),
          ),
        ),
      ).rejects.toThrow(/references only/);
    });

    it('audit metadata is allowlisted', async () => {
      const id = await runInTenant(ctx(tenantA), () =>
        withTransaction((tx) =>
          audit.record(
            { kind: 'user', id: 'usr_1' },
            'x.y',
            { type: 't', id: 'r1' },
            { allowed: false, reason: 'role_missing' },
            tx,
            { toState: 'z', accessToken: 'SECRET', email: 'a@b.c' },
          ),
        ),
      );
      const row = (await tdb.db.select().from(auditEvents).where(eq(auditEvents.id, id)))[0]!;
      expect(row.decision).toBe('denied');
      expect(row.reason).toBe('role_missing');
      expect(row.metadata).toEqual({ toState: 'z' });
    });

    it('audit queries are tenant-scoped and paginated', async () => {
      await runInTenant(ctx(tenantB), () =>
        withTransaction((tx) =>
          audit.record({ kind: 'user', id: 'usr_9' }, 'x.y', { type: 't', id: 'rB' }, 'allowed', tx),
        ),
      );
      const page = await runInTenant(ctx(tenantA), () => audit.query({ resourceType: 't' }, { limit: 1 }));
      expect(page.items.length).toBe(1);
      expect(page.items.every((r) => r.tenantId === tenantA)).toBe(true);
      const b = await runInTenant(ctx(tenantA), () => audit.query({ resourceId: 'rB' }, { limit: 50 }));
      expect(b.items.length).toBe(0);
    });
  });

  describe('kill switches and flags', () => {
    it('tenant-wide or brand switch engages; releasing clears; audited', async () => {
      await runInTenant(ctx(tenantA), async () => {
        expect(await killSwitch.isOn('release_dispatch', brandA)).toBe(false);
        await killSwitch.set('release_dispatch', brandA, true, 'incident 42', { kind: 'user', id: 'usr_1' });
        expect(await killSwitch.isOn('release_dispatch', brandA)).toBe(true);
        expect(await killSwitch.isOn('agent_starts', brandA)).toBe(false);
        await killSwitch.set('release_dispatch', brandA, false, null, { kind: 'user', id: 'usr_1' });
        await killSwitch.set('agent_starts', null, true, 'tenant-wide', { kind: 'user', id: 'usr_1' });
        expect(await killSwitch.isOn('agent_starts', brandA)).toBe(true);
        expect(await killSwitch.isOn('agent_starts', newId('brand'))).toBe(true);
      });
      await runInTenant(ctx(tenantB), async () => {
        expect(await killSwitch.isOn('agent_starts', brandA)).toBe(false);
      });
      expect(
        (await tdb.db.select().from(killSwitches).where(eq(killSwitches.tenantId, tenantA))).length,
      ).toBe(2);
    });

    it('flag evaluation: default off; tenant allowlist; stable percentage bucketing', () => {
      const def = FLAG_DEFINITIONS[0]!;
      expect(evaluateFlag(null, def, 'ten_x')).toBe(false);
      expect(evaluateFlag({ enabledDefault: false, targeting: { tenantIds: ['ten_x'] } }, def, 'ten_x')).toBe(
        true,
      );
      expect(evaluateFlag({ enabledDefault: false, targeting: { tenantIds: ['ten_x'] } }, def, 'ten_y')).toBe(
        false,
      );
      const on = evaluateFlag({ enabledDefault: false, targeting: { percentage: 50 } }, def, 'ten_y');
      expect(evaluateFlag({ enabledDefault: false, targeting: { percentage: 50 } }, def, 'ten_y')).toBe(on);
      expect(evaluateFlag({ enabledDefault: false, targeting: { percentage: 100 } }, def, 'ten_y')).toBe(
        true,
      );
      expect(evaluateFlag({ enabledDefault: false, targeting: { percentage: 0 } }, def, 'ten_y')).toBe(false);
      for (const d of FLAG_DEFINITIONS) {
        expect(d.owner.length).toBeGreaterThan(0);
        expect(Date.parse(d.removalDate)).toBeGreaterThan(Date.now());
        expect(d.successMetric.length).toBeGreaterThan(0);
        expect(d.enabledDefault).toBe(false);
      }
    });
  });
});
