import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { PreRegistrationV1 } from '@oremedia/contracts/experiments';
import type { ResolvedActor, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { memberships, tenants, users } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { contentPackages, contentRevisions } from '@oremedia/db/schema/content';
import { experimentAssignments, experimentResults, experiments } from '@oremedia/db/schema/experiments';
import { auditEvents, featureFlags, outboxEvents } from '@oremedia/db/schema/operations';
import { assignVariant } from '@oremedia/domain/experiments/index';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { registerExperimentListener, resetExperimentListeners, type ExperimentMilestone } from './hooks';
import { experimentsService } from './service';

interface Person {
  id: string;
  actor: ResolvedActor;
}

describe('experiments module (spec 16.6) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandB = newId('brand');
  let analyst: Person;
  let analystB: Person;
  const agent: ResolvedActorServicePrincipal = {
    kind: 'service_principal',
    id: newId('servicePrincipal'),
    tenantId: tenantA,
    status: 'active',
    maxAutonomy: 'create',
    grants: [
      { action: 'brand.read', brandIds: 'all' },
      { action: 'experiment.manage', brandIds: 'all' },
      { action: 'insight.read', brandIds: 'all' },
    ],
  };
  const revisions: string[] = [];
  const milestones: ExperimentMilestone[] = [];

  const ctx = (tenantId: string, actorId: string): TenantContext => ({
    tenantId,
    actor: { kind: 'user', id: actorId },
    brandIds: 'all',
    correlationId: 'corr_experiments',
  });
  const run = <T>(tenantId: string, actorId: string, fn: (tx: Tx) => Promise<T>) =>
    runInTenant(ctx(tenantId, actorId), () => withTransaction(fn));
  const runA = <T>(fn: (tx: Tx) => Promise<T>) => run(tenantA, analyst.id, fn);
  const row = async (id: string) =>
    (await tdb.db.select().from(experiments).where(eq(experiments.id, id)))[0]!;

  async function person(tenantId: string, label: string, role: 'analyst' | 'creator'): Promise<Person> {
    const id = newId('user');
    const membershipId = newId('membership');
    await tdb.db
      .insert(users)
      .values({ id, email: `${label}-${id.slice(-6).toLowerCase()}@example.test`, name: label });
    await tdb.db
      .insert(memberships)
      .values({ id: membershipId, tenantId, userId: id, role, status: 'active', allBrands: true });
    return {
      id,
      actor: {
        kind: 'user',
        id,
        tenantId,
        membershipId,
        membershipStatus: 'active',
        role,
        allBrands: true,
        brandGrants: [],
        mfaEnrolled: false,
      },
    };
  }
  /** A content revision row of the brand (the experiments module reads it through the content module's public read). */
  async function revision(tenantId: string, brandId: string, label: string) {
    const packageId = newId('contentPackage');
    const revisionId = newId('contentRevision');
    await tdb.db.insert(contentPackages).values({
      id: packageId,
      tenantId,
      brandId,
      briefId: null,
      title: label,
      currentRevisionId: revisionId,
      state: 'draft',
      version: 1,
    });
    await tdb.db.insert(contentRevisions).values({
      id: revisionId,
      tenantId,
      brandId,
      packageId,
      number: 1,
      brandVersionId: newId('brandVersion'),
      policyVersionId: newId('policyVersion'),
      copy: { schemaVersion: 1, master: { text: label, factRefs: [] } },
      creativeRevisionIds: [],
      factRefs: [],
      contentHash: hashCanonical({ label }),
      state: 'draft',
      authorKind: 'user',
      authorId: 'usr_seed',
    });
    return revisionId;
  }
  const design = (over: Partial<PreRegistrationV1> = {}): PreRegistrationV1 => ({
    v: 1,
    hypothesis: 'A question-led hook raises the qualified enquiry rate per click',
    mode: 'randomised',
    variants: [
      { label: 'control', contentRevisionId: revisions[0]!, allocationWeight: 1 },
      { label: 'question_hook', contentRevisionId: revisions[1]!, allocationWeight: 1 },
    ],
    primaryMetricKey: 'qualified_enquiry_rate',
    guardrailMetricKeys: ['complaints'],
    guardrailThresholds: { complaints: 0.05 },
    guardrailDirections: { complaints: 'up' },
    allocationMethod: 'hashed_visitor',
    unitType: 'visitor',
    minSamplePerArm: 200,
    observationWindowHours: 24,
    stoppingRule: { kind: 'fixed_horizon', alpha: 0.05 },
    ...over,
  });
  /** create → pre-register → start, returning the running row's id, hash, variant ids and version. */
  async function running(over: Partial<PreRegistrationV1> = {}) {
    const created = await runA((tx) =>
      experimentsService.create(analyst.actor, { brandId: brandA, design: design(over) }, tx),
    );
    const pre = await runA((tx) =>
      experimentsService.preRegister(
        analyst.actor,
        { experimentId: created.experimentId, expectedVersion: 0 },
        tx,
      ),
    );
    const started = await runA((tx) =>
      experimentsService.start(
        analyst.actor,
        { experimentId: created.experimentId, expectedVersion: pre.version },
        tx,
      ),
    );
    const dto = await runA((tx) =>
      experimentsService.get(analyst.actor, { experimentId: created.experimentId }, tx),
    );
    return {
      id: created.experimentId,
      hash: pre.preRegistrationHash,
      variants: dto.variants.map((v) => v.id),
      version: started.version,
      startedAt: new Date(dto.startedAt!),
    };
  }
  const after = (startedAt: Date, hours: number) =>
    new Date(startedAt.getTime() + hours * 3600_000 + 1000).toISOString();

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'xp-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'xp-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    analyst = await person(tenantA, 'analyst', 'analyst');
    analystB = await person(tenantB, 'analyst-b', 'analyst');
    revisions.push(
      await revision(tenantA, brandA, 'control copy'),
      await revision(tenantA, brandA, 'question hook copy'),
    );
    await tdb.db.insert(featureFlags).values({
      key: 'experiments.randomised',
      enabledDefault: false,
      targeting: { tenantIds: [tenantA] },
      owner: 'experiments',
      removalDate: new Date('2027-03-31T00:00:00Z'),
      successMetric: 'test',
    });
    registerExperimentListener(async (m) => {
      milestones.push(m);
    });
  });
  afterAll(async () => {
    resetExperimentListeners();
    await tdb?.drop();
  });

  describe('design and pre-registration', () => {
    it('creates a designed experiment with its variants; pre-registration freezes the design with its hash', async () => {
      const created = await runA((tx) =>
        experimentsService.create(analyst.actor, { brandId: brandA, design: design() }, tx),
      );
      expect(created).toMatchObject({ state: 'designed', version: 0 });
      const pre = await runA((tx) =>
        experimentsService.preRegister(
          analyst.actor,
          { experimentId: created.experimentId, expectedVersion: 0 },
          tx,
        ),
      );
      expect(pre.state).toBe('pre_registered');
      const stored = await row(created.experimentId);
      expect(stored.preRegistrationHash).toBe(pre.preRegistrationHash);
      expect(hashCanonical(stored.preRegistration)).toBe(pre.preRegistrationHash);
      expect(stored.preRegistration).toMatchObject({
        v: 1,
        minSamplePerArm: 200,
        stoppingRule: { kind: 'fixed_horizon', alpha: 0.05 },
        unitType: 'visitor',
      });
      expect(milestones.at(-1)).toMatchObject({
        kind: 'pre_registered',
        experimentId: created.experimentId,
        preRegistrationHash: pre.preRegistrationHash,
      });
      // Frozen: pre-registering again is an illegal transition.
      await expect(
        runA((tx) =>
          experimentsService.preRegister(
            analyst.actor,
            { experimentId: created.experimentId, expectedVersion: pre.version },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });

    it('an agent may propose a design (a draft) but never pre-registers or starts one', async () => {
      const created = await runInTenant(
        { ...ctx(tenantA, agent.id), actor: { kind: 'service_principal', id: agent.id } },
        () =>
          withTransaction((tx) =>
            experimentsService.create(
              agent,
              {
                brandId: brandA,
                design: design({
                  variants: [
                    { label: 'a', contentRevisionId: '', allocationWeight: 1 },
                    { label: 'b', contentRevisionId: '', allocationWeight: 1 },
                  ],
                }),
              },
              tx,
              { autonomyMode: 'create' },
            ),
          ),
      );
      expect((await row(created.experimentId)).createdByKind).toBe('agent');
      await expect(
        runInTenant({ ...ctx(tenantA, agent.id), actor: { kind: 'service_principal', id: agent.id } }, () =>
          withTransaction((tx) =>
            experimentsService.preRegister(
              agent,
              { experimentId: created.experimentId, expectedVersion: 0 },
              tx,
            ),
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      // A person cannot pre-register it either until every variant names a revision of the brand.
      await expect(
        runA((tx) =>
          experimentsService.preRegister(
            analyst.actor,
            { experimentId: created.experimentId, expectedVersion: 0 },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('a creator cannot manage experiments; a foreign tenant sees NOT_FOUND and writes nothing', async () => {
      const creator = await person(tenantA, 'creator', 'creator');
      await expect(
        run(tenantA, creator.id, (tx) =>
          experimentsService.create(creator.actor, { brandId: brandA, design: design() }, tx),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const created = await runA((tx) =>
        experimentsService.create(analyst.actor, { brandId: brandA, design: design() }, tx),
      );
      await expect(
        run(tenantB, analystB.id, (tx) =>
          experimentsService.get(analystB.actor, { experimentId: created.experimentId }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantB, analystB.id, (tx) =>
          experimentsService.preRegister(
            analystB.actor,
            { experimentId: created.experimentId, expectedVersion: 0 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect((await row(created.experimentId)).state).toBe('designed');
    });
  });

  describe('running and results', () => {
    it('start needs the flag for a randomised experiment, emits experiment.started and records the executed revision', async () => {
      const x = await running();
      expect((await row(x.id)).state).toBe('running');
      const events = await tdb.db
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.aggregateId, x.id)));
      expect(events.map((e) => e.eventType)).toContain('experiment.started');
      expect(milestones.find((m) => m.kind === 'started' && m.experimentId === x.id)).toMatchObject({
        executedRevisionId: revisions[1],
      });
      // Tenant B has no flag: a randomised experiment cannot start there.
      const rb = await revision(tenantB, brandB, 'b copy');
      const createdB = await run(tenantB, analystB.id, (tx) =>
        experimentsService.create(
          analystB.actor,
          {
            brandId: brandB,
            design: design({
              variants: [
                { label: 'c', contentRevisionId: rb, allocationWeight: 1 },
                { label: 't', contentRevisionId: rb, allocationWeight: 1 },
              ],
            }),
          },
          tx,
        ),
      );
      const preB = await run(tenantB, analystB.id, (tx) =>
        experimentsService.preRegister(
          analystB.actor,
          { experimentId: createdB.experimentId, expectedVersion: 0 },
          tx,
        ),
      );
      await expect(
        run(tenantB, analystB.id, (tx) =>
          experimentsService.start(
            analystB.actor,
            { experimentId: createdB.experimentId, expectedVersion: preB.version },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'feature_flag_off' });
    });

    it('rejects results against a changed design and never declares them before the sample and window', async () => {
      const x = await running();
      const observations = [
        { variantId: x.variants[0]!, n: 1000, x: 50, guardrails: { complaints: 10 } },
        { variantId: x.variants[1]!, n: 1000, x: 90, guardrails: { complaints: 11 } },
      ];
      await expect(
        runA((tx) =>
          experimentsService.results(
            analyst.actor,
            {
              experimentId: x.id,
              preRegistrationHash: 'b'.repeat(64),
              observations,
              at: after(x.startedAt, 25),
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [{ path: 'preRegistrationHash', issue: 'design_changed' }],
      });
      // Window not reached.
      await expect(
        runA((tx) =>
          experimentsService.results(
            analyst.actor,
            { experimentId: x.id, preRegistrationHash: x.hash, observations, at: after(x.startedAt, 1) },
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        message: 'Results are not declared before the pre-registered sample and window are reached',
      });
      // Sample not reached.
      await expect(
        runA((tx) =>
          experimentsService.results(
            analyst.actor,
            {
              experimentId: x.id,
              preRegistrationHash: x.hash,
              observations: observations.map((o) => ({ ...o, n: 100, x: 5 })),
              at: after(x.startedAt, 25),
            },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(
        await tdb.db.select().from(experimentResults).where(eq(experimentResults.experimentId, x.id)),
      ).toHaveLength(0);
      expect((await row(x.id)).state).toBe('running');
    });

    it('supported: a significant primary-metric win with no guardrail breach (two-proportion, Holm) ends as analysed', async () => {
      const x = await running();
      const result = await runA((tx) =>
        experimentsService.results(
          analyst.actor,
          {
            experimentId: x.id,
            preRegistrationHash: x.hash,
            observations: [
              { variantId: x.variants[0]!, n: 1000, x: 50, exposure: 20_000, guardrails: { complaints: 10 } },
              { variantId: x.variants[1]!, n: 1000, x: 90, exposure: 19_000, guardrails: { complaints: 11 } },
            ],
            at: after(x.startedAt, 25),
          },
          tx,
        ),
      );
      expect(result).toMatchObject({
        verdict: 'supported',
        verdictReason: 'primary_metric_improved',
        methodVersion: 'two_proportion_holm_v1',
        conclusionLabel: 'causal_when_sound',
        state: 'analysed',
      });
      expect(result.estimate).toBeCloseTo(0.04, 6);
      expect(result.pValue).toBeLessThan(0.05);
      expect(result.perVariant[x.variants[1]!]).toMatchObject({ n: 1000, x: 90, exposure: 19_000 });
      const stored = (
        await tdb.db.select().from(experimentResults).where(eq(experimentResults.experimentId, x.id))
      )[0]!;
      expect(stored.preRegistrationHash).toBe(x.hash);
      expect(milestones.find((m) => m.kind === 'analysed' && m.experimentId === x.id)).toMatchObject({
        verdict: 'supported',
        resultId: result.resultId,
        mode: 'randomised',
      });
      const audits = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.resourceId, x.id)));
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'experiment.create',
          'experiment.pre_register',
          'experiment.start',
          'experiment.analyse',
        ]),
      );
    });

    it('not_supported: a primary win with a guardrail breach beyond the pre-registered threshold', async () => {
      const x = await running();
      const result = await runA((tx) =>
        experimentsService.results(
          analyst.actor,
          {
            experimentId: x.id,
            preRegistrationHash: x.hash,
            observations: [
              { variantId: x.variants[0]!, n: 1000, x: 50, guardrails: { complaints: 10 } },
              { variantId: x.variants[1]!, n: 1000, x: 90, guardrails: { complaints: 80 } },
            ],
            at: after(x.startedAt, 25),
          },
          tx,
        ),
      );
      expect(result.verdict).toBe('not_supported');
      expect(result.guardrailBreached).toEqual([`complaints:${x.variants[1]}`]);
      expect(result.verdictReason).toMatch(/^guardrail_breach:complaints/);
    });

    it('inconclusive is a normal, recorded outcome when the difference is not significant', async () => {
      const x = await running();
      const result = await runA((tx) =>
        experimentsService.results(
          analyst.actor,
          {
            experimentId: x.id,
            preRegistrationHash: x.hash,
            observations: [
              { variantId: x.variants[0]!, n: 400, x: 20, guardrails: {} },
              { variantId: x.variants[1]!, n: 400, x: 23, guardrails: {} },
            ],
            at: after(x.startedAt, 25),
          },
          tx,
        ),
      );
      expect(result).toMatchObject({
        verdict: 'inconclusive',
        verdictReason: 'not_significant',
        state: 'analysed',
      });
      const list = await runA((tx) =>
        experimentsService.resultsGet(analyst.actor, { experimentId: x.id }, tx),
      );
      expect(list.items).toHaveLength(1);
      expect(list.items[0]!.verdict).toBe('inconclusive');
    });

    it('a structured comparison reports the same statistics labelled "directional; not causal"', async () => {
      const x = await running({
        mode: 'structured_comparison',
        allocationMethod: 'matched_slots',
        unitType: 'publication_slot',
        minSamplePerArm: 50,
      });
      const result = await runA((tx) =>
        experimentsService.results(
          analyst.actor,
          {
            experimentId: x.id,
            preRegistrationHash: x.hash,
            observations: [
              { variantId: x.variants[0]!, n: 500, x: 25, guardrails: {} },
              { variantId: x.variants[1]!, n: 500, x: 60, guardrails: {} },
            ],
            at: after(x.startedAt, 25),
          },
          tx,
        ),
      );
      expect(result.conclusionLabel).toBe('directional; not causal');
      expect(result.verdictReason).toBe('directional; not causal: primary_metric_improved');
      expect(result.methodVersion).toBe('structured_comparison:two_proportion_holm_v1');
      expect(milestones.find((m) => m.kind === 'analysed' && m.experimentId === x.id)?.mode).toBe(
        'structured_comparison',
      );
    });

    it('a pre-registered sequential rule (mSPRT) may analyse early and keeps running while inconclusive', async () => {
      const x = await running({ stoppingRule: { kind: 'sequential_msprt', alpha: 0.05, tau: 1 } });
      const early = await runA((tx) =>
        experimentsService.results(
          analyst.actor,
          {
            experimentId: x.id,
            preRegistrationHash: x.hash,
            observations: [
              { variantId: x.variants[0]!, n: 30, x: 3, guardrails: {} },
              { variantId: x.variants[1]!, n: 30, x: 4, guardrails: {} },
            ],
            at: after(x.startedAt, 1),
          },
          tx,
        ),
      );
      expect(early).toMatchObject({ verdict: 'inconclusive', methodVersion: 'msprt_v1', state: 'running' });
      const later = await runA((tx) =>
        experimentsService.results(
          analyst.actor,
          {
            experimentId: x.id,
            preRegistrationHash: x.hash,
            observations: [
              { variantId: x.variants[0]!, n: 2000, x: 100, guardrails: {} },
              { variantId: x.variants[1]!, n: 2000, x: 220, guardrails: {} },
            ],
            at: after(x.startedAt, 2),
          },
          tx,
        ),
      );
      expect(later).toMatchObject({ verdict: 'supported', state: 'analysed' });
    });

    it('assigns hashed visitors with the shared pure function, deterministically and idempotently', async () => {
      const x = await running();
      const hash = 'c'.repeat(40);
      const first = await runA((tx) =>
        experimentsService.assign(
          analyst.actor,
          { experimentId: x.id, unitType: 'visitor', unitIdHash: hash },
          tx,
        ),
      );
      const second = await runA((tx) =>
        experimentsService.assign(
          analyst.actor,
          { experimentId: x.id, unitType: 'visitor', unitIdHash: hash },
          tx,
        ),
      );
      expect(first.existing).toBe(false);
      expect(second).toMatchObject({ variantId: first.variantId, existing: true });
      const arms = [...x.variants].sort().map((id) => ({ id, allocationWeight: 1 }));
      expect(first.variantId).toBe(assignVariant(hash, x.id, arms)); // what the redirector computes on its own
      expect(
        await tdb.db.select().from(experimentAssignments).where(eq(experimentAssignments.experimentId, x.id)),
      ).toHaveLength(1);
      const stopped = await runA((tx) =>
        experimentsService.stop(analyst.actor, { experimentId: x.id, expectedVersion: x.version }, tx),
      );
      expect(stopped.state).toBe('stopped');
      await expect(
        runA((tx) =>
          experimentsService.assign(
            analyst.actor,
            { experimentId: x.id, unitType: 'visitor', unitIdHash: 'd'.repeat(40) },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    });
  });
});
