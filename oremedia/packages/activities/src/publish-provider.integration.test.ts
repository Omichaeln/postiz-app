import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { NotFoundError } from '@oremedia/contracts/errors';
import type {
  PublishOnceInputV1,
  PublishProviderRuntimeV1,
  TokenRefreshWorkflowInputV1,
} from '@oremedia/contracts/publishing';
import { requireTenant } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { newId } from '@oremedia/domain/ids';
import { createPublishProviderActivities } from './publish-provider';
import { createTokenRefreshActivities } from './token-refresh';

/**
 * The provider-queue and token-refresh activity hosts (spec 14.3, 14.7, ledger 5.33): tenant context from the
 * input with grants re-loaded, the per-activity heartbeat handed to the runtime (spec 20.3), payloads that carry
 * ids only, and a mismatched tenant refused before any runtime code (and so before any credential is opened).
 */
describe('publish provider and token refresh activities (MockActivityEnvironment against MySQL)', () => {
  let tdb: TestDatabase;
  const env = new MockActivityEnvironment();
  const run = <A, R>(fn: (arg: A) => Promise<R>, arg: A): Promise<R> => env.run(fn, arg) as Promise<R>;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const userA = newId('user');
  const seen: Array<{ method: string; tenantId: string; hooks: boolean }> = [];
  const providerRuntime = (fail?: () => never): PublishProviderRuntimeV1 => {
    const record = (method: string, hooks?: { heartbeat(d: string): void }) => {
      hooks?.heartbeat(`from-runtime:${method}`);
      seen.push({ method, tenantId: requireTenant().tenantId, hooks: hooks !== undefined });
      if (fail) fail();
    };
    return {
      publishOnce: async (_i, hooks) => (
        record('publishOnce', hooks),
        { attemptId: 'att_1', outcome: 'accepted', remotePostId: 'p', remoteUrl: 'u' }
      ),
      checkStatus: async (_i, hooks) => (record('checkStatus', hooks), { status: 'ready' as const }),
      finalize: async (_i, hooks) => (
        record('finalize', hooks),
        { status: 'completed' as const, remotePostId: 'p', remoteUrl: 'u' }
      ),
      findRemotePost: async (_i, hooks) => (
        record('findRemotePost', hooks),
        { status: 'definitely_absent' as const }
      ),
    };
  };
  const call = (tenantId = tenantA): PublishOnceInputV1 => ({
    tenantId,
    actor: { kind: 'user', id: userA },
    correlationId: 'corr_prov',
    publicationId: 'pub_1',
    attemptId: 'att_1',
    fencingToken: 1,
  });
  const refreshInput = (tenantId = tenantA): TokenRefreshWorkflowInputV1 => ({
    tenantId,
    actor: { kind: 'user', id: userA },
    correlationId: 'corr_prov',
    channelConnectionId: 'cc_1',
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'act-prov-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'act-prov-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db
      .insert(users)
      .values({ id: userA, email: `prov-${userA.slice(-6).toLowerCase()}@example.test`, name: 'A' });
    await tdb.db.insert(memberships).values({
      id: newId('membership'),
      tenantId: tenantA,
      userId: userA,
      role: 'publisher',
      status: 'active',
      allBrands: true,
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('runs every provider activity in tenant context with the heartbeat handed to the runtime', async () => {
    const acts = createPublishProviderActivities(providerRuntime());
    const heartbeats: unknown[] = [];
    env.on('heartbeat', (d) => heartbeats.push(d));
    expect(await run(acts.publishOnce, call())).toMatchObject({ outcome: 'accepted' });
    await run(acts.checkStatus, call());
    await run(acts.finalize, call());
    await run(acts.findRemotePost, { ...call(), attemptId: 'att_1' });
    expect(seen.map((s) => s.method)).toEqual(['publishOnce', 'checkStatus', 'finalize', 'findRemotePost']);
    expect(seen.every((s) => s.tenantId === tenantA && s.hooks)).toBe(true);
    expect(heartbeats).toEqual([
      'publish:att_1:start',
      'from-runtime:publishOnce',
      'from-runtime:checkStatus',
      'from-runtime:finalize',
      'from-runtime:findRemotePost',
    ]);
  });

  it('a mismatched tenantId is refused before the runtime (no credential is ever opened), non-retryably', async () => {
    seen.length = 0;
    const acts = createPublishProviderActivities(providerRuntime());
    for (const bad of [call(tenantB), call(newId('tenant'))]) {
      const err = await run(acts.publishOnce, bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).type).toBe('PolicyDenied');
      expect((err as ApplicationFailure).nonRetryable).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  it('a NOT_FOUND from the runtime (a foreign publication or attempt id) is a non-retryable PolicyDenied', async () => {
    const acts = createPublishProviderActivities(
      providerRuntime(() => {
        throw new NotFoundError('PublicationAttempt', 'att_x');
      }),
    );
    const err = await run(acts.findRemotePost, { ...call(), attemptId: 'att_x' }).catch((e: unknown) => e);
    expect((err as ApplicationFailure).type).toBe('PolicyDenied');
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('token refresh activities: tenant context established; a foreign tenant refused', async () => {
    const calls: string[] = [];
    const acts = createTokenRefreshActivities({
      readRefreshSchedule: async () => (
        calls.push(requireTenant().tenantId),
        { status: 'active', tokenExpiresAt: null }
      ),
      refreshCredentials: async () => (
        calls.push(requireTenant().tenantId),
        { ok: true, tokenExpiresAt: null }
      ),
    });
    await run(acts.readRefreshSchedule, refreshInput());
    await run(acts.refreshCredentials, refreshInput());
    expect(calls).toEqual([tenantA, tenantA]);
    const err = await run(acts.refreshCredentials, refreshInput(tenantB)).catch((e: unknown) => e);
    expect((err as ApplicationFailure).type).toBe('PolicyDenied');
    expect(calls).toHaveLength(2);
  });
});
