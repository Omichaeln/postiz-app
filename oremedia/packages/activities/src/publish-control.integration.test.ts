import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { ConflictError, NotFoundError, ValidationFailedError } from '@oremedia/contracts/errors';
import type {
  PublicationWorkflowInputV1,
  PublishControlRuntimeV1,
  TransitionResultV1,
} from '@oremedia/contracts/publishing';
import { requireTenant } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { newId } from '@oremedia/domain/ids';
import { createPublicationSweepActivities, createPublishControlActivities } from './publish-control';

/**
 * Spec 5.2 / 14.3 / ledger 5.33 for the control activity host: every activity re-establishes tenant context from
 * its input with the scheduling actor's grants re-loaded at the point of effect; a tenantId that does not match
 * the actor's membership (or an unknown actor) fails as a non-retryable PolicyDenied before the runtime runs;
 * domain errors map to the failure types the workflow's retry policy understands. The runtime is a fake here
 * (the publishing module's own integration test drives the real one).
 */
describe('publish control activities (MockActivityEnvironment against MySQL)', () => {
  let tdb: TestDatabase;
  const env = new MockActivityEnvironment();
  const run = <A, R>(fn: (arg: A) => Promise<R>, arg: A): Promise<R> => env.run(fn, arg) as Promise<R>;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const userA = newId('user');
  const seen: Array<{ method: string; tenantId: string; brandIds: unknown }> = [];
  const ok = (state: TransitionResultV1['state']): TransitionResultV1 => ({
    state,
    version: 1,
    changed: true,
  });
  const fakeRuntime = (fail?: () => never): PublishControlRuntimeV1 => {
    const record = (method: string) => {
      const ctx = requireTenant();
      seen.push({ method, tenantId: ctx.tenantId, brandIds: ctx.brandIds });
      if (fail) fail();
    };
    return {
      readSchedule: async () => (
        record('readSchedule'),
        { state: 'scheduled', scheduledFor: 'x', version: 0 }
      ),
      cancelIfNotStarted: async () => (record('cancelIfNotStarted'), ok('cancelled')),
      claimForDispatch: async () => (
        record('claimForDispatch'),
        { ok: true, fencingToken: 1, providerKey: 'fixture_provider', channelConnectionId: 'cc_1' }
      ),
      evaluateRelease: async () => (record('evaluateRelease'), { allow: true }),
      hold: async () => (record('hold'), ok('held')),
      releaseClaimAndCancel: async () => (record('releaseClaimAndCancel'), ok('cancelled')),
      openAttempt: async () => (record('openAttempt'), 'att_1'),
      markProcessing: async () => (record('markProcessing'), ok('processing')),
      markPublished: async () => (record('markPublished'), ok('published')),
      markFailed: async () => (record('markFailed'), ok('failed')),
      markOutcomeUnknown: async () => (record('markOutcomeUnknown'), ok('outcome_unknown')),
      markRetryEligible: async () => (record('markRetryEligible'), ok('retry_eligible')),
      holdForHuman: async () => (record('holdForHuman'), ok('held')),
      retryAfterProvenNoEffect: async () => (
        record('retryAfterProvenNoEffect'),
        { retried: false, reason: 'state' as const }
      ),
    };
  };
  const input = (tenantId = tenantA, userId = userA): PublicationWorkflowInputV1 => ({
    tenantId,
    actor: { kind: 'user', id: userId },
    correlationId: 'corr_ctl',
    publicationId: 'pub_1',
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'act-pub-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'act-pub-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db
      .insert(users)
      .values({ id: userA, email: `ctl-${userA.slice(-6).toLowerCase()}@example.test`, name: 'A' });
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

  it('establishes tenant context with the actor grants re-loaded now, for every control activity', async () => {
    const acts = createPublishControlActivities(fakeRuntime());
    await run(acts.readSchedule, input());
    await run(acts.claimForDispatch, { ...input(), claimant: 'pub:pub_1:run' });
    await run(acts.evaluateRelease, { ...input(), fencingToken: 1 });
    await run(acts.openAttempt, { ...input(), fencingToken: 1 });
    await run(acts.markPublished, {
      ...input(),
      attempt: { attemptId: 'att_1', outcome: 'accepted', remotePostId: 'p' },
    });
    await run(acts.markOutcomeUnknown, { ...input(), attemptId: 'att_1' });
    await run(acts.holdForHuman, { ...input(), reason: 'outcome_unknown_unresolved' });
    expect(seen.map((s) => s.method)).toEqual([
      'readSchedule',
      'claimForDispatch',
      'evaluateRelease',
      'openAttempt',
      'markPublished',
      'markOutcomeUnknown',
      'holdForHuman',
    ]);
    expect(seen.every((s) => s.tenantId === tenantA && s.brandIds === 'all')).toBe(true);
  });

  it('a tenantId the actor is not a member of, or an unknown actor, is a non-retryable PolicyDenied before the runtime runs (ledger 5.33)', async () => {
    seen.length = 0;
    const acts = createPublishControlActivities(fakeRuntime());
    for (const bad of [input(tenantB), input(tenantA, newId('user')), input(newId('tenant'))]) {
      const err = await run(acts.claimForDispatch, { ...bad, claimant: 'x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApplicationFailure);
      expect((err as ApplicationFailure).type).toBe('PolicyDenied');
      expect((err as ApplicationFailure).nonRetryable).toBe(true);
    }
    expect(seen).toEqual([]);
  });

  it.each([
    [
      () => {
        throw new NotFoundError('Publication', 'pub_x');
      },
      'PolicyDenied',
      true,
    ],
    [
      () => {
        throw new ValidationFailedError([{ issue: 'stale_fencing_token' }]);
      },
      'ValidationFailed',
      true,
    ],
    [
      () => {
        throw Object.assign(new Error('illegal'), { name: 'IllegalTransitionError' });
      },
      'ValidationFailed',
      true,
    ],
  ] as const)('maps domain errors to the workflow failure types (%#)', async (fail, type, nonRetryable) => {
    const acts = createPublishControlActivities(fakeRuntime(fail as () => never));
    const err = await run(acts.readSchedule, input()).catch((e: unknown) => e);
    expect((err as ApplicationFailure).type).toBe(type);
    expect((err as ApplicationFailure).nonRetryable).toBe(nonRetryable);
  });

  it('a concurrent-modification conflict propagates as a plain (retryable) error: the activity re-reads on retry', async () => {
    const acts = createPublishControlActivities(
      fakeRuntime(() => {
        throw new ConflictError('Publication', 'pub_1', 0);
      }),
    );
    const err = await run(acts.hold, { ...input(), reasons: ['x'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
  });

  it('the sweeper activity carries no tenant and passes its input through', async () => {
    const acts = createPublicationSweepActivities({
      sweepPublications: async (i) => ({ scheduledReemitted: i.graceSeconds, dispatchingExpired: 0 }),
    });
    expect(
      await run(acts.sweepPublications, {
        correlationId: 'c',
        now: new Date().toISOString(),
        claimLeaseSeconds: 60,
        graceSeconds: 7,
      }),
    ).toEqual({ scheduledReemitted: 7, dispatchingExpired: 0 });
  });
});
