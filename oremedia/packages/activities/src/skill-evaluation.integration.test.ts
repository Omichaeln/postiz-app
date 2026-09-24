import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { NotFoundError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { EvaluationReport, SkillEvaluationWorkflowInputV1 } from '@oremedia/contracts/skills';
import { requireTenant } from '@oremedia/db';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { servicePrincipals, tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { newId } from '@oremedia/domain/ids';
import { createSkillEvaluationActivities, type SkillEvaluationStore } from './skill-evaluation';

/**
 * Spec 5.2 / 10.2 for the activity host: the one evaluation activity re-establishes tenant context from its
 * input (re-loading a principal's grants; a platform operator keeps the every-brand context the API established),
 * runs the suite with no transaction open, heartbeats while the runner is busy, records in one transaction and
 * turns domain errors into non-retryable failures. The store is a fake here (the skills module's own integration
 * test drives the real runEvaluation / recordEvaluation); MockActivityEnvironment needs no Temporal server.
 */
describe('skill evaluation activity (MockActivityEnvironment against MySQL)', () => {
  let tdb: TestDatabase;
  const env = new MockActivityEnvironment();
  const run = <A, R>(fn: (arg: A) => Promise<R>, arg: A): Promise<R> => env.run(fn, arg) as Promise<R>;
  const tenantA = newId('tenant');
  const brandA = newId('brand');
  const spRestricted = newId('servicePrincipal');
  const report = (skillVersionId: string): EvaluationReport => ({
    skillVersionId,
    runs: 3,
    cases: [],
    passed: true,
    gradedBy: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const seen: Array<{ method: string; brandIds: ReadonlySet<string> | 'all'; actorKind: string }> = [];
  /** The fake's version state: the fail path moves it to draft once and is a no-op after that. */
  let fakeState: 'sandbox_evaluation' | 'draft' = 'sandbox_evaluation';
  const failed: Array<{ reason: string; moved: boolean }> = [];
  const fakeStore = (opts: { skip?: boolean; fail?: () => never } = {}): SkillEvaluationStore => {
    const record = (method: string) => {
      const ctx = requireTenant();
      seen.push({ method, brandIds: ctx.brandIds, actorKind: ctx.actor.kind });
      if (opts.fail) opts.fail();
    };
    return {
      async runEvaluation(input) {
        record('runEvaluation');
        return {
          skillVersionId: input.skillVersionId,
          state: opts.skip ? 'in_review' : 'sandbox_evaluation',
          report: opts.skip ? null : report(input.skillVersionId),
        };
      },
      async failEvaluation(input) {
        record('failEvaluation');
        const moved = fakeState === 'sandbox_evaluation';
        fakeState = 'draft';
        failed.push({ reason: input.reason, moved });
      },
      async recordEvaluation(input) {
        record('recordEvaluation');
        return {
          outcome: 'recorded',
          skillVersionId: input.skillVersionId,
          suiteId: input.suiteId,
          resultId: 'evr_1',
          passed: input.report.passed,
          state: 'in_review',
        };
      },
    };
  };
  const input = (
    actor: SkillEvaluationWorkflowInputV1['actor'] = { kind: 'service_principal', id: spRestricted },
  ): SkillEvaluationWorkflowInputV1 => ({
    tenantId: tenantA,
    actor,
    correlationId: 'corr_eval',
    skillVersionId: 'skv_1',
    skillId: 'skl_1',
    suiteId: 'evs_1',
    runs: 3,
  });

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db
      .insert(tenants)
      .values({ id: tenantA, name: 'A', slug: 'act-skills-' + tenantA.slice(-6).toLowerCase() });
    await tdb.db.insert(brands).values({
      id: brandA,
      tenantId: tenantA,
      name: 'A1',
      timezone: 'UTC',
      defaultLocale: 'en',
      status: 'active',
    });
    await tdb.db.insert(servicePrincipals).values({
      id: spRestricted,
      tenantId: tenantA,
      kind: 'agent',
      name: 'restricted',
      grants: [{ action: 'skill.author', brandIds: [brandA] }],
      maxAutonomy: 'create',
      status: 'active',
      createdByUserId: 'usr_x',
    });
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  it('runs then records in the requester context (grants re-loaded now), heartbeating around the runner', async () => {
    seen.length = 0;
    const heartbeats: unknown[] = [];
    env.on('heartbeat', (d) => heartbeats.push(d));
    const acts = createSkillEvaluationActivities({ store: fakeStore() });
    expect(await run(acts.runSkillEvaluation, input())).toEqual({
      outcome: 'recorded',
      skillVersionId: 'skv_1',
      suiteId: 'evs_1',
      resultId: 'evr_1',
      passed: true,
      state: 'in_review',
    });
    expect(seen.map((s) => s.method)).toEqual(['runEvaluation', 'recordEvaluation']);
    expect(seen.every((s) => s.actorKind === 'service_principal')).toBe(true);
    expect(seen[0]?.brandIds).toEqual(new Set([brandA]));
    expect(heartbeats).toEqual(['evaluate:run', 'evaluate:record']);
  });

  it('a version that already left the sandbox is skipped without a write', async () => {
    seen.length = 0;
    const acts = createSkillEvaluationActivities({ store: fakeStore({ skip: true }) });
    expect(await run(acts.runSkillEvaluation, input())).toEqual({
      outcome: 'skipped',
      skillVersionId: 'skv_1',
      state: 'in_review',
    });
    expect(seen.map((s) => s.method)).toEqual(['runEvaluation']);
  });

  it('a platform operator (built-in skill) runs in the every-brand context the API established', async () => {
    seen.length = 0;
    const acts = createSkillEvaluationActivities({ store: fakeStore() });
    await run(acts.runSkillEvaluation, input({ kind: 'platform_operator', id: 'usr_op' }));
    expect(seen[0]).toEqual({ method: 'runEvaluation', brandIds: 'all', actorKind: 'platform_operator' });
  });

  it('failSkillEvaluation returns the version to draft in one transaction; a second call is a no-op', async () => {
    seen.length = 0;
    failed.length = 0;
    const acts = createSkillEvaluationActivities({ store: fakeStore() });
    await run(acts.failSkillEvaluation, { ...input(), error: 'model unavailable' });
    await run(acts.failSkillEvaluation, { ...input(), error: 'model unavailable' });
    expect(seen.map((s) => s.method)).toEqual(['failEvaluation', 'failEvaluation']);
    expect(seen[0]?.brandIds).toEqual(new Set([brandA]));
    expect(failed).toEqual([
      { reason: 'model unavailable', moved: true },
      { reason: 'model unavailable', moved: false },
    ]);
  });

  it('a foreign tenant fails as a non-retryable PolicyDenied before the store runs', async () => {
    seen.length = 0;
    const acts = createSkillEvaluationActivities({ store: fakeStore() });
    const foreign = await run(acts.runSkillEvaluation, { ...input(), tenantId: newId('tenant') }).catch(
      (e: unknown) => e,
    );
    expect(foreign).toBeInstanceOf(ApplicationFailure);
    expect((foreign as ApplicationFailure).type).toBe('PolicyDenied');
    const foreignFail = await run(acts.failSkillEvaluation, {
      ...input(),
      tenantId: newId('tenant'),
      error: 'x',
    }).catch((e: unknown) => e);
    expect((foreignFail as ApplicationFailure).type).toBe('PolicyDenied');
    expect(seen).toEqual([]);
  });

  it.each([
    [new NotFoundError('SkillVersion', 'skv_x'), 'PolicyDenied'],
    [new ValidationFailedError([{ issue: 'evaluation_report_mismatch' }]), 'ValidationFailed'],
  ] as const)('maps %s to non-retryable type %s', async (error, type) => {
    const acts = createSkillEvaluationActivities({
      store: fakeStore({
        fail: () => {
          throw error;
        },
      }),
    });
    const failure = await run(acts.runSkillEvaluation, input()).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).type).toBe(type);
    expect((failure as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('anything else (a model outage) propagates unchanged so Temporal retries it', async () => {
    const acts = createSkillEvaluationActivities({
      store: fakeStore({
        fail: () => {
          throw new Error('model unavailable');
        },
      }),
    });
    await expect(run(acts.runSkillEvaluation, input())).rejects.toThrow('model unavailable');
  });
});
