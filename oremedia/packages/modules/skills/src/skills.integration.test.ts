import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import {
  SkillImport,
  SkillVersionCreate,
  SkillVersionEvaluate,
  SkillVersionPublish,
  TOOL_NAMES_RELEASE_1,
  type EvaluationCase,
  type ResolvedSkill,
  type SkillManifestV1,
} from '@oremedia/contracts/skills';
import { createTestDatabase, type TestDatabase } from '@oremedia/db/testing';
import { requireTenant, runInTenant, withTransaction, type TenantContext, type Tx } from '@oremedia/db';
import { tenants } from '@oremedia/db/schema/access';
import { brands } from '@oremedia/db/schema/brand';
import { auditEvents, outboxEvents } from '@oremedia/db/schema/operations';
import {
  evaluationResults,
  evaluationSuites,
  skillBindings,
  skillVersions,
  skills,
} from '@oremedia/db/schema/skills';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { BUILTIN_SKILL_KEYS, loadBuiltinSkills, seedBuiltinSkills } from './builtin';
import { manifestJson, toPackage } from './package-format';
import {
  registerBrandChecker,
  registerEvaluationRunner,
  rolloutBucket,
  skillsService,
  type EvaluationRunner,
} from './service';

const USER = 'usr_skill_test';
const ADMIN = 'usr_skill_admin';
const OPERATOR = 'usr_skill_operator';
const ctx = (tenantId: string, brandIds: ReadonlySet<string> | 'all' = 'all'): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: USER },
  brandIds,
  correlationId: 'corr_skill',
});
const operatorCtx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'platform_operator', id: OPERATOR },
  brandIds: 'all',
  correlationId: 'corr_skill',
  supportSessionId: 'ss_skill_test',
});
const manager = (
  tenantId: string,
  role: 'brand_manager' | 'admin' = 'brand_manager',
  id = USER,
): ResolvedActor => ({
  kind: 'user',
  id,
  tenantId,
  membershipId: 'mem_skill_test',
  membershipStatus: 'active',
  role,
  allBrands: true,
  brandGrants: [],
  mfaEnrolled: false,
});
const admin = (tenantId: string) => manager(tenantId, 'admin', ADMIN);
const agent = (tenantId: string): ResolvedActor => ({
  kind: 'service_principal',
  id: 'sp_skill_test',
  tenantId,
  status: 'active',
  maxAutonomy: 'create',
  grants: [
    { action: 'brand.read', brandIds: 'all' },
    { action: 'skill.author', brandIds: 'all' },
    { action: 'skill.publish', brandIds: 'all' },
  ],
});
const operator = (tenantId: string): ResolvedActor => ({
  kind: 'platform_operator',
  id: OPERATOR,
  tenantId,
  supportSessionId: 'ss_skill_test',
  mode: 'escalated',
  expired: false,
});

/** Runs a command the way the router does: tenant context + one transaction. */
const run = <T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
  brandIds: ReadonlySet<string> | 'all' = 'all',
) => runInTenant(ctx(tenantId, brandIds), () => withTransaction(fn));
const runAsOperator = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
  runInTenant(operatorCtx(tenantId), () => withTransaction(fn));

const manifest = (key: string, over: Partial<SkillManifestV1> = {}): SkillManifestV1 => ({
  schemaVersion: 1,
  key,
  title: `Skill ${key}`,
  description: 'test skill',
  taskKinds: ['copywriting'],
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  requiredContext: ['brand_snapshot'],
  allowedTools: ['brand.getSnapshot', 'facts.list'],
  budgets: { maxSteps: 5, maxTokens: 1000, maxCostMicros: 1000, maxVariants: 1, deadlineSeconds: 60 },
  modelCompatibility: ['anthropic:*'],
  instructionsPath: 'SKILL.md',
  ...over,
});
const cases: EvaluationCase[] = [
  {
    id: 'c1',
    title: 'first case',
    input: { brief: 'x' },
    brandFixtureRef: 'fixture-brand',
    expected: {
      properties: ['schema_valid', 'no_prohibited_terms'],
      rubric: [{ dimension: 'voice', description: 'sounds like the brand', minScore: 7 }],
    },
  },
];
const INSTRUCTIONS = '# Test skill\n\nWrite on-brand copy. Never invent facts.\n';
/** Services take the parsed DTO (defaults applied), as the router hands it to them. */
const createInput = (v: z.input<typeof SkillVersionCreate>) => SkillVersionCreate.parse(v);
const evaluateInput = (v: z.input<typeof SkillVersionEvaluate>) => SkillVersionEvaluate.parse(v);
const publishInput = (v: z.input<typeof SkillVersionPublish>) => SkillVersionPublish.parse(v);
const importInput = (v: z.input<typeof SkillImport>) => SkillImport.parse(v);

describe('skills module (spec 10) against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA1 = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');
  const A = manager(tenantA);
  const ADM = admin(tenantA);
  let runnerMode: 'pass' | 'fail' = 'pass';
  const runnerCalls: Array<Parameters<EvaluationRunner>[0]> = [];
  let skillId = '';
  let v1 = '';
  let v2 = '';
  let v3 = '';
  let copywritingBuiltinId = '';
  let copywritingBuiltinV1 = '';
  let copywritingBuiltinV2 = '';
  let skillB = '';
  let versionB = '';

  const versionRow = async (id: string) =>
    (await tdb.db.select().from(skillVersions).where(eq(skillVersions.id, id)))[0]!;
  const skillRow = async (id: string) => (await tdb.db.select().from(skills).where(eq(skills.id, id)))[0]!;
  const eventsOf = async (type: string) =>
    tdb.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.tenantId, tenantA), eq(outboxEvents.eventType, type)));
  const tenantRows = async (tenantId: string) =>
    JSON.stringify({
      skills: await tdb.db.select().from(skills).where(eq(skills.tenantId, tenantId)),
      versions: await tdb.db.select().from(skillVersions).where(eq(skillVersions.tenantId, tenantId)),
      bindings: await tdb.db.select().from(skillBindings).where(eq(skillBindings.tenantId, tenantId)),
      results: await tdb.db.select().from(evaluationResults).where(eq(evaluationResults.tenantId, tenantId)),
    });
  const resolve = (brandId: string, taskKind: 'copywriting' | 'layout' = 'copywriting', tenantId = tenantA) =>
    runInTenant(ctx(tenantId), () => skillsService.resolveForRun(agent(tenantId), { brandId, taskKind }));
  const versionOf = (resolved: ResolvedSkill[], key: string) =>
    resolved.find((s) => s.key === key)?.versionNumber;

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'skill-a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'skill-b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    await tdb.db.insert(brands).values([
      { id: brandA1, tenantId: tenantA, name: 'A1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandA2, tenantId: tenantA, name: 'A2', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
      { id: brandB, tenantId: tenantB, name: 'B1', timezone: 'UTC', defaultLocale: 'en', status: 'active' },
    ]);
    // The composition root wires this to brandService.assertExist; the test reads the brand table directly.
    registerBrandChecker({
      assertExist: async (ids, tx) => {
        const { tenantId } = requireTenant();
        const rows = await withTransaction(tx, (t) =>
          t
            .select({ id: brands.id })
            .from(brands)
            .where(and(eq(brands.tenantId, tenantId), inArray(brands.id, ids))),
        );
        const found = new Set(rows.map((r) => r.id));
        const missing = ids.find((i) => !found.has(i));
        if (missing) throw new NotFoundError('Brand', missing);
      },
    });
    // A fixture runner: passes or fails every expected property depending on runnerMode, grades rubric at 9.
    registerEvaluationRunner(async (input) => {
      runnerCalls.push(input);
      const now = new Date().toISOString();
      return {
        skillVersionId: input.skillVersionId,
        runs: input.runs,
        cases: input.cases.map((c) => ({
          caseId: c.id,
          deterministic: c.expected.properties.map((p) => ({ check: p, passed: runnerMode === 'pass' })),
          rubric: (c.expected.rubric ?? []).map((r) => ({
            dimension: r.dimension,
            mean: 9,
            variance: 0.25,
            scores: [9, 8.5, 9.5],
          })),
          passed: runnerMode === 'pass',
        })),
        passed: runnerMode === 'pass',
        gradedBy: { provider: 'fixture', model: 'grader-1' },
        startedAt: now,
        finishedAt: now,
      };
    });
    // Tenant B has a skill and a draft version of its own, for the foreign-id checks.
    const b = await run(tenantB, (tx) =>
      skillsService.versions.create(
        manager(tenantB),
        createInput({ manifest: manifest('b-skill'), instructions: INSTRUCTIONS, references: [], cases }),
        tx,
      ),
    );
    skillB = b.skillId;
    versionB = b.skillVersionId;
  });
  afterAll(async () => {
    await tdb?.drop();
  });

  describe('built-in skills (spec 10.4)', () => {
    it('the eight Release 1 packages load from disk, validate and stay inside the tool registry', async () => {
      const builtins = await loadBuiltinSkills();
      expect(builtins.map((b) => b.key)).toEqual([...BUILTIN_SKILL_KEYS]);
      for (const b of builtins) {
        expect(b.manifest.key).toBe(b.key);
        expect(b.manifest.taskKinds.length).toBeGreaterThan(0);
        expect(
          b.manifest.allowedTools.every((t) => (TOOL_NAMES_RELEASE_1 as readonly string[]).includes(t)),
        ).toBe(true);
        expect(b.cases.length).toBeGreaterThanOrEqual(2);
        for (const c of b.cases) expect(c.expected.properties.length).toBeGreaterThan(0);
        expect(b.instructions).toContain('## Never');
        expect(b.instructions).toContain('Precedence');
        expect(Object.keys(b.references).length).toBeGreaterThan(0);
        expect(b.packageHash).toHaveLength(64);
      }
    });

    it('seeding registers them as platform skills with version 1 in draft and a suite; it is idempotent', async () => {
      const first = await seedBuiltinSkills();
      expect(first.seeded).toEqual([...BUILTIN_SKILL_KEYS]);
      expect(first.skipped).toEqual([]);
      const again = await seedBuiltinSkills();
      expect(again.seeded).toEqual([]);
      expect(again.skipped).toEqual([...BUILTIN_SKILL_KEYS]);
      const rows = await tdb.db
        .select()
        .from(skills)
        .where(and(eq(skills.scope, 'platform'), isNull(skills.tenantId)));
      expect(rows.length).toBe(8);
      const versions = await tdb.db
        .select()
        .from(skillVersions)
        .where(
          inArray(
            skillVersions.skillId,
            rows.map((r) => r.id),
          ),
        );
      expect(versions.every((v) => v.state === 'draft' && v.number === 1 && v.tenantId === null)).toBe(true);
      const suites = await tdb.db
        .select()
        .from(evaluationSuites)
        .where(
          inArray(
            evaluationSuites.skillVersionId,
            versions.map((v) => v.id),
          ),
        );
      expect(suites.length).toBe(8);
      copywritingBuiltinId = rows.find((r) => r.key === 'brand-copywriting')!.id;
      copywritingBuiltinV1 = versions.find((v) => v.skillId === copywritingBuiltinId)!.id;
    });

    it('platform skills are readable by every tenant', async () => {
      const listA = await runInTenant(ctx(tenantA), () =>
        skillsService.list(A, { scope: 'platform', page: { limit: 50 } }),
      );
      expect(listA.items.map((s) => s.key).sort()).toEqual([...BUILTIN_SKILL_KEYS].sort());
      const listB = await runInTenant(ctx(tenantB), () =>
        skillsService.list(manager(tenantB), { scope: 'platform', page: { limit: 50 } }),
      );
      expect(listB.items.length).toBe(8);
      const got = await runInTenant(ctx(tenantA), () =>
        skillsService.get(A, { skillId: copywritingBuiltinId }),
      );
      expect(got.scope).toBe('platform');
      expect(got.versions.map((v) => v.state)).toEqual(['draft']);
      const exported = await runInTenant(ctx(tenantA), () =>
        skillsService.export(A, { skillVersionId: copywritingBuiltinV1 }),
      );
      expect(exported.files.map((f) => f.path)).toContain('references/caption-checklist.md');
    });

    it('a tenant user cannot edit, evaluate, publish or bind a platform skill at platform scope', async () => {
      const builtin = (await loadBuiltinSkills()).find((b) => b.key === 'brand-copywriting')!;
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.create(
            A,
            createInput({
              skillId: copywritingBuiltinId,
              manifest: builtin.manifest,
              instructions: builtin.instructions,
            }),
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'platform_skill_read_only' });
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.evaluate(
            A,
            evaluateInput({ skillVersionId: copywritingBuiltinV1, expectedVersion: 0 }),
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.publish(
            ADM,
            publishInput({ skillVersionId: copywritingBuiltinV1, expectedVersion: 0 }),
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.bindings.set(
            ADM,
            { scope: 'platform', skillId: copywritingBuiltinId, skillVersionId: copywritingBuiltinV1 },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ reason: 'platform_skill_read_only' });
      expect((await versionRow(copywritingBuiltinV1)).state).toBe('draft');
    });

    it('a platform operator (escalated support session) evaluates and publishes a built-in; every tenant then resolves it', async () => {
      const evaluated = await runAsOperator(tenantA, (tx) =>
        skillsService.versions.evaluate(
          operator(tenantA),
          evaluateInput({ skillVersionId: copywritingBuiltinV1, expectedVersion: 0 }),
          tx,
        ),
      );
      expect(evaluated).toMatchObject({ passed: true, state: 'in_review', version: 2 });
      const result = (
        await tdb.db.select().from(evaluationResults).where(eq(evaluationResults.id, evaluated.resultId))
      )[0]!;
      expect(result.tenantId).toBeNull();
      const published = await runAsOperator(tenantA, (tx) =>
        skillsService.versions.publish(
          operator(tenantA),
          publishInput({ skillVersionId: copywritingBuiltinV1, expectedVersion: 2, rolloutPercent: 100 }),
          tx,
        ),
      );
      expect(published).toMatchObject({ state: 'published', rolloutPercent: 100 });
      expect((await skillRow(copywritingBuiltinId)).activeVersionId).toBe(copywritingBuiltinV1);
      const builtin = (await loadBuiltinSkills()).find((b) => b.key === 'brand-copywriting')!;
      for (const [tenantId, brandId] of [
        [tenantA, brandA1],
        [tenantB, brandB],
      ] as const) {
        const resolved = await resolve(brandId, 'copywriting', tenantId);
        const hit = resolved.find((s) => s.key === 'brand-copywriting')!;
        expect(hit).toMatchObject({
          skillVersionId: copywritingBuiltinV1,
          skillId: copywritingBuiltinId,
          versionNumber: 1,
          instructions: builtin.instructions,
        });
        expect(hit.manifest).toEqual(builtin.manifest);
        expect(hit.references.map((r) => r.path)).toEqual(['references/caption-checklist.md']);
      }
      // Other built-ins are still drafts and are never resolved.
      const layout = await resolve(brandA1, 'layout');
      expect(layout.find((s) => s.key === 'social-layout')).toBeUndefined();
      const operatorAudit = await tdb.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, tenantA), eq(auditEvents.action, 'skill.version.publish')));
      expect(operatorAudit[0]!.supportSessionId).toBe('ss_skill_test');
    });
  });

  describe('lifecycle (spec 10.2)', () => {
    it('versions.create stores a pinned draft with its package hash and suite', async () => {
      const created = await run(tenantA, (tx) =>
        skillsService.versions.create(
          A,
          createInput({
            manifest: manifest('tenant-copy'),
            instructions: INSTRUCTIONS,
            references: [{ path: 'references/notes.md', content: 'notes\n' }],
            cases,
          }),
          tx,
        ),
      );
      skillId = created.skillId;
      v1 = created.skillVersionId;
      expect(created).toMatchObject({ key: 'tenant-copy', number: 1, version: 0 });
      expect(created.suiteId).not.toBeNull();
      const row = await versionRow(v1);
      expect(row.state).toBe('draft');
      expect(row.tenantId).toBe(tenantA);
      expect(row.packageHash).toBe(
        hashCanonical({
          files: toPackage({
            manifest: manifest('tenant-copy'),
            instructions: INSTRUCTIONS,
            references: { 'references/notes.md': 'notes\n' },
          }),
        }),
      );
      expect(created.packageHash).toBe(row.packageHash);
      expect((await skillRow(skillId)).activeVersionId).toBeNull();
    });

    it('a draft cannot be published; evaluate calls the runner with the pinned content and stores the report', async () => {
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.publish(ADM, publishInput({ skillVersionId: v1, expectedVersion: 0 }), tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      runnerCalls.length = 0;
      const evaluated = await run(tenantA, (tx) =>
        skillsService.versions.evaluate(
          A,
          evaluateInput({ skillVersionId: v1, expectedVersion: 0, runs: 3 }),
          tx,
        ),
      );
      expect(evaluated).toMatchObject({ skillVersionId: v1, passed: true, state: 'in_review', version: 2 });
      expect(runnerCalls.length).toBe(1);
      expect(runnerCalls[0]).toMatchObject({ skillVersionId: v1, instructions: INSTRUCTIONS, runs: 3 });
      expect(runnerCalls[0]!.manifest).toEqual(manifest('tenant-copy'));
      expect(runnerCalls[0]!.cases).toEqual(cases);
      const result = (
        await tdb.db.select().from(evaluationResults).where(eq(evaluationResults.id, evaluated.resultId))
      )[0]!;
      expect(result).toMatchObject({
        tenantId: tenantA,
        skillVersionId: v1,
        modelVersion: 'fixture:grader-1',
        runs: 3,
        passed: true,
        scores: { 'c1/voice': 9 },
        variance: { 'c1/voice': 0.25 },
        deterministicChecks: { 'c1/schema_valid': true, 'c1/no_prohibited_terms': true },
      });
      expect((await versionRow(v1)).state).toBe('in_review');
      const events = (await eventsOf('skill.version_evaluated')).filter((e) => e.aggregateId === v1);
      expect(events.length).toBe(1);
      expect(events[0]!.payload).toMatchObject({ skillVersionId: v1, passed: true, toState: 'in_review' });
    });

    it('agents never publish (propose_only); a brand manager lacks skill.publish; an admin publishes and the skill activates the version', async () => {
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.publish(
            agent(tenantA),
            publishInput({ skillVersionId: v1, expectedVersion: 2 }),
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.publish(A, publishInput({ skillVersionId: v1, expectedVersion: 2 }), tx),
        ),
      ).rejects.toMatchObject({ reason: 'role_missing' });
      expect((await versionRow(v1)).state).toBe('in_review');
      const published = await run(tenantA, (tx) =>
        skillsService.versions.publish(
          ADM,
          publishInput({ skillVersionId: v1, expectedVersion: 2, rolloutPercent: 100 }),
          tx,
        ),
      );
      expect(published).toMatchObject({ number: 1, state: 'published', rolloutPercent: 100, version: 3 });
      const row = await versionRow(v1);
      expect(row.publishedAt).not.toBeNull();
      expect((await skillRow(skillId)).activeVersionId).toBe(v1);
      const events = await eventsOf('skill.version_published');
      expect(events.map((e) => e.aggregateId)).toContain(v1);
      expect(events.find((e) => e.aggregateId === v1)!.payload).toMatchObject({
        skillId,
        number: 1,
        rolloutPercent: 100,
        packageHash: row.packageHash,
        previousActiveVersionId: null,
      });
    });

    it('a failed evaluation returns the version to draft; publish needs a passing latest evaluation of that exact version', async () => {
      const created = await run(tenantA, (tx) =>
        skillsService.versions.create(
          A,
          createInput({
            skillId,
            manifest: manifest('tenant-copy'),
            instructions: INSTRUCTIONS + 'v2\n',
            cases,
          }),
          tx,
        ),
      );
      v2 = created.skillVersionId;
      expect(created.number).toBe(2);
      runnerMode = 'fail';
      const failed = await run(tenantA, (tx) =>
        skillsService.versions.evaluate(A, evaluateInput({ skillVersionId: v2, expectedVersion: 0 }), tx),
      );
      expect(failed).toMatchObject({ passed: false, state: 'draft', version: 2 });
      expect((await versionRow(v2)).state).toBe('draft');
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.publish(ADM, publishInput({ skillVersionId: v2, expectedVersion: 2 }), tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      runnerMode = 'pass';
      const passed = await run(tenantA, (tx) =>
        skillsService.versions.evaluate(A, evaluateInput({ skillVersionId: v2, expectedVersion: 2 }), tx),
      );
      expect(passed).toMatchObject({ passed: true, state: 'in_review', version: 4 });
      // A later failing result for this exact version blocks publishing even though the state is in_review.
      const injected = newId('evaluationResult');
      const suite = (
        await tdb.db.select().from(evaluationSuites).where(eq(evaluationSuites.skillVersionId, v2))
      )[0]!;
      await tdb.db.insert(evaluationResults).values({
        id: injected,
        tenantId: tenantA,
        suiteId: suite.id,
        skillVersionId: v2,
        modelVersion: 'none',
        runs: 3,
        scores: {},
        variance: {},
        deterministicChecks: { 'c1/schema_valid': false },
        passed: false,
      });
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.publish(ADM, publishInput({ skillVersionId: v2, expectedVersion: 4 }), tx),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'skillVersionId', issue: 'evaluation_required' }] });
      await tdb.db.delete(evaluationResults).where(eq(evaluationResults.id, injected));
      const published = await run(tenantA, (tx) =>
        skillsService.versions.publish(
          ADM,
          publishInput({ skillVersionId: v2, expectedVersion: 4, rolloutPercent: 30 }),
          tx,
        ),
      );
      expect(published).toMatchObject({ number: 2, state: 'published', rolloutPercent: 30, version: 5 });
      expect((await skillRow(skillId)).activeVersionId).toBe(v2);
      // v1 stays published so it can be rolled back to.
      expect((await versionRow(v1)).state).toBe('published');
    });

    it('a version without cases cannot be evaluated; an illegal transition is rejected', async () => {
      const created = await run(tenantA, (tx) =>
        skillsService.versions.create(
          A,
          createInput({ skillId, manifest: manifest('tenant-copy'), instructions: INSTRUCTIONS + 'v3\n' }),
          tx,
        ),
      );
      v3 = created.skillVersionId;
      expect(created.suiteId).toBeNull();
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.evaluate(A, evaluateInput({ skillVersionId: v3, expectedVersion: 0 }), tx),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'cases', issue: 'no_evaluation_cases' }] });
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.evaluate(A, evaluateInput({ skillVersionId: v1, expectedVersion: 3 }), tx),
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect((await versionRow(v3)).state).toBe('draft');
    });
  });

  describe('rollout and bindings (spec 10.2, 12.3)', () => {
    it('rollout % is deterministic from tenant, brand, skill and version number; the rest falls back to an earlier published version', async () => {
      const expectedFor = (brandId: string) =>
        rolloutBucket({ tenantId: tenantA, brandId, skillId, versionNumber: 2 }) < 30 ? 2 : 1;
      for (const brandId of [brandA1, brandA2]) {
        const first = await resolve(brandId);
        expect(versionOf(first, 'tenant-copy')).toBe(expectedFor(brandId));
        for (let i = 0; i < 3; i++)
          expect(versionOf(await resolve(brandId), 'tenant-copy')).toBe(expectedFor(brandId));
      }
      // Rollout adjustments on a published version change no state.
      const to100 = await run(tenantA, (tx) =>
        skillsService.versions.publish(
          ADM,
          publishInput({ skillVersionId: v2, expectedVersion: 5, rolloutPercent: 100 }),
          tx,
        ),
      );
      expect(to100).toMatchObject({ state: 'published', rolloutPercent: 100, version: 6 });
      expect(versionOf(await resolve(brandA1), 'tenant-copy')).toBe(2);
      expect(versionOf(await resolve(brandA2), 'tenant-copy')).toBe(2);
      await run(tenantA, (tx) =>
        skillsService.versions.publish(
          ADM,
          publishInput({ skillVersionId: v2, expectedVersion: 6, rolloutPercent: 0 }),
          tx,
        ),
      );
      expect(versionOf(await resolve(brandA1), 'tenant-copy')).toBe(1);
      await run(tenantA, (tx) =>
        skillsService.versions.publish(
          ADM,
          publishInput({ skillVersionId: v2, expectedVersion: 7, rolloutPercent: 100 }),
          tx,
        ),
      );
      expect(versionOf(await resolve(brandA1), 'tenant-copy')).toBe(2);
    });

    it('rollback = binding an earlier published version at the skill scope; it affects future resolution only', async () => {
      const before = await resolve(brandA1);
      const hit = before.find((s) => s.key === 'tenant-copy')!;
      expect(hit.skillVersionId).toBe(v2);
      const rolledBack = await run(tenantA, (tx) =>
        skillsService.bindings.set(ADM, { scope: 'tenant', skillId, skillVersionId: v1 }, tx),
      );
      expect(rolledBack).toMatchObject({ scope: 'tenant', skillVersionId: v1, previousVersionId: v2 });
      expect((await skillRow(skillId)).activeVersionId).toBe(v1);
      expect(hit.skillVersionId).toBe(v2); // the earlier run keeps its pinned version
      expect(versionOf(await resolve(brandA1), 'tenant-copy')).toBe(1);
      expect(versionOf(await resolve(brandA2), 'tenant-copy')).toBe(1);
      expect((await versionRow(v2)).state).toBe('published');
    });

    it('brand bindings take precedence over the tenant binding; null unbinds; only published versions of the skill bind', async () => {
      const bound = await run(tenantA, (tx) =>
        skillsService.bindings.set(
          ADM,
          { scope: 'brand', brandId: brandA1, skillId, skillVersionId: v2 },
          tx,
        ),
      );
      expect(bound).toMatchObject({
        scope: 'brand',
        brandId: brandA1,
        skillVersionId: v2,
        previousVersionId: null,
      });
      const rows = await tdb.db.select().from(skillBindings).where(eq(skillBindings.skillVersionId, v2));
      expect(rows.map((r) => [r.tenantId, r.brandId, r.taskKind])).toEqual([
        [tenantA, brandA1, 'copywriting'],
      ]);
      expect(versionOf(await resolve(brandA1), 'tenant-copy')).toBe(2);
      expect(versionOf(await resolve(brandA2), 'tenant-copy')).toBe(1);
      const got = await runInTenant(ctx(tenantA), () => skillsService.get(A, { skillId }));
      expect(got.bindings).toEqual([
        expect.objectContaining({ scope: 'brand', brandId: brandA1, skillVersionId: v2 }),
      ]);
      expect(got.versions.map((v) => v.number)).toEqual([3, 2, 1]);
      expect(got.evaluations.length).toBeGreaterThanOrEqual(3);
      const unbound = await run(tenantA, (tx) =>
        skillsService.bindings.set(
          ADM,
          { scope: 'brand', brandId: brandA1, skillId, skillVersionId: null },
          tx,
        ),
      );
      expect(unbound).toMatchObject({ skillVersionId: null, previousVersionId: v2 });
      expect(
        (await tdb.db.select().from(skillBindings).where(eq(skillBindings.skillVersionId, v2))).length,
      ).toBe(0);
      expect(versionOf(await resolve(brandA1), 'tenant-copy')).toBe(1);
      await expect(
        run(tenantA, (tx) =>
          skillsService.bindings.set(
            ADM,
            { scope: 'brand', brandId: brandA1, skillId, skillVersionId: v3 },
            tx,
          ),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'skillVersionId', issue: 'version_not_published' }] });
      await expect(
        run(tenantA, (tx) =>
          skillsService.bindings.set(ADM, { scope: 'platform', skillId, skillVersionId: v1 }, tx),
        ),
      ).rejects.toMatchObject({ details: [{ path: 'scope', issue: 'scope_wider_than_skill' }] });
      await expect(
        run(tenantA, (tx) =>
          skillsService.bindings.set(
            ADM,
            { scope: 'brand', brandId: brandA1, skillId, skillVersionId: copywritingBuiltinV1 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.bindings.set(agent(tenantA), { scope: 'tenant', skillId, skillVersionId: v2 }, tx),
        ),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
    });

    it('a tenant binding of a platform skill outranks the platform default, for that tenant only', async () => {
      const builtin = (await loadBuiltinSkills()).find((b) => b.key === 'brand-copywriting')!;
      const created = await runAsOperator(tenantA, (tx) =>
        skillsService.versions.create(
          operator(tenantA),
          createInput({
            skillId: copywritingBuiltinId,
            manifest: builtin.manifest,
            instructions: builtin.instructions + '\nRevision 2.\n',
            references: Object.entries(builtin.references).map(([path, content]) => ({ path, content })),
            cases: builtin.cases,
          }),
          tx,
        ),
      );
      copywritingBuiltinV2 = created.skillVersionId;
      expect(created.number).toBe(2);
      expect((await versionRow(copywritingBuiltinV2)).tenantId).toBeNull();
      await runAsOperator(tenantA, (tx) =>
        skillsService.versions.evaluate(
          operator(tenantA),
          evaluateInput({ skillVersionId: copywritingBuiltinV2, expectedVersion: 0 }),
          tx,
        ),
      );
      await runAsOperator(tenantA, (tx) =>
        skillsService.versions.publish(
          operator(tenantA),
          publishInput({ skillVersionId: copywritingBuiltinV2, expectedVersion: 2, rolloutPercent: 100 }),
          tx,
        ),
      );
      expect(versionOf(await resolve(brandA1), 'brand-copywriting')).toBe(2);
      expect(versionOf(await resolve(brandB, 'copywriting', tenantB), 'brand-copywriting')).toBe(2);
      await run(tenantA, (tx) =>
        skillsService.bindings.set(
          ADM,
          { scope: 'tenant', skillId: copywritingBuiltinId, skillVersionId: copywritingBuiltinV1 },
          tx,
        ),
      );
      expect(versionOf(await resolve(brandA1), 'brand-copywriting')).toBe(1);
      expect(versionOf(await resolve(brandA2), 'brand-copywriting')).toBe(1);
      expect(versionOf(await resolve(brandB, 'copywriting', tenantB), 'brand-copywriting')).toBe(2);
      expect((await skillRow(copywritingBuiltinId)).activeVersionId).toBe(copywritingBuiltinV2);
    });

    it('resolveForRun never returns drafts or skills for other task kinds, and respects brand visibility', async () => {
      await run(tenantA, (tx) =>
        skillsService.versions.create(
          A,
          createInput({
            manifest: manifest('layout-only', { taskKinds: ['layout'] }),
            instructions: INSTRUCTIONS,
          }),
          tx,
        ),
      );
      const resolved = await resolve(brandA1);
      expect(resolved.map((s) => s.key)).toEqual(['brand-copywriting', 'tenant-copy']);
      expect(
        resolved.every((s) => s.instructions.length > 0 && s.manifest.taskKinds.includes('copywriting')),
      ).toBe(true);
      await expect(
        runInTenant(ctx(tenantA, new Set([brandA2])), () =>
          skillsService.resolveForRun(agent(tenantA), { brandId: brandA1, taskKind: 'copywriting' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('Agent Skills package round-trip (spec 10.1)', () => {
    it('export(import(pkg)) returns the same files, byte for byte, for a manifest.json package', async () => {
      const m = manifest('imported-skill');
      const files = [
        { path: 'references/checklist.md', content: '# Checklist\n\n- one\n' },
        { path: 'SKILL.md', content: '# Imported\n\nBody with `code` and $dollars.\n' },
        { path: 'assets/example.json', content: '{"a":1}\n' },
        { path: 'manifest.json', content: manifestJson(m) },
      ];
      const imported = await run(tenantA, (tx) => skillsService.import(A, importInput({ files }), tx));
      expect(imported).toMatchObject({ key: 'imported-skill', number: 1 });
      const exported = await runInTenant(ctx(tenantA), () =>
        skillsService.export(A, { skillVersionId: imported.skillVersionId }),
      );
      expect(Object.fromEntries(exported.files.map((f) => [f.path, f.content]))).toEqual(
        Object.fromEntries(files.map((f) => [f.path, f.content])),
      );
      expect(exported.packageHash).toBe(imported.packageHash);
      const again = await run(tenantA, (tx) => skillsService.import(A, importInput({ files }), tx));
      expect(again).toMatchObject({
        skillId: imported.skillId,
        number: 2,
        packageHash: imported.packageHash,
      });
    });

    it('a SKILL.md with YAML front matter imports to the same manifest and exports in the manifest.json form', async () => {
      const skillMd = [
        '---',
        'schemaVersion: 1',
        'key: front-matter-skill',
        'title: "Front matter skill"',
        'description: test skill',
        'taskKinds: [copywriting]',
        'inputSchema: {"type":"object"}',
        'outputSchema: {"type":"object"}',
        'requiredContext:',
        '  - brand_snapshot',
        'allowedTools:',
        '  - brand.getSnapshot',
        '  - facts.list',
        'budgets:',
        '  maxSteps: 5',
        '  maxTokens: 1000',
        '  maxCostMicros: 1000',
        '  maxVariants: 1',
        '  deadlineSeconds: 60',
        "modelCompatibility: ['anthropic:*']",
        'instructionsPath: SKILL.md',
        '---',
        '# Front matter skill',
        '',
        'Body.',
        '',
      ].join('\n');
      const imported = await run(tenantA, (tx) =>
        skillsService.import(A, importInput({ files: [{ path: 'SKILL.md', content: skillMd }] }), tx),
      );
      const exported = await runInTenant(ctx(tenantA), () =>
        skillsService.export(A, { skillVersionId: imported.skillVersionId }),
      );
      const expected = manifest('front-matter-skill', { title: 'Front matter skill' });
      expect(exported.files).toEqual([
        { path: 'SKILL.md', content: '# Front matter skill\n\nBody.\n' },
        { path: 'manifest.json', content: manifestJson(expected) },
      ]);
    });
  });

  describe('refusals (spec 10.1, 12.4)', () => {
    const attempt = (input: z.input<typeof SkillVersionCreate>) =>
      run(tenantA, (tx) => skillsService.versions.create(A, createInput(input), tx));
    it('executable content is refused at create and at import, and nothing is written', async () => {
      const before = await tenantRows(tenantA);
      const base = { manifest: manifest('exec-skill'), instructions: INSTRUCTIONS };
      for (const references of [
        [{ path: 'scripts/run.md', content: 'echo' }],
        [{ path: 'references/helper.py', content: 'print(1)' }],
        [{ path: 'references/tool', content: '#!/usr/bin/env bash\necho' }],
        [{ path: 'references/bundle.js', content: 'console.log(1)' }],
      ])
        await expect(attempt({ ...base, references })).rejects.toMatchObject({
          details: [{ path: references[0]!.path, issue: 'executable_content_prohibited' }],
        });
      await expect(
        attempt({ ...base, manifest: { ...manifest('exec-skill'), scripts: { run: 'node x.js' } } }),
      ).rejects.toMatchObject({
        details: [{ path: 'manifest.scripts', issue: 'executable_content_prohibited' }],
      });
      await expect(
        run(tenantA, (tx) =>
          skillsService.import(
            A,
            importInput({
              files: [
                { path: 'SKILL.md', content: INSTRUCTIONS },
                { path: 'manifest.json', content: manifestJson(manifest('exec-skill')) },
                { path: 'scripts/setup.sh', content: 'echo' },
              ],
            }),
            tx,
          ),
        ),
      ).rejects.toMatchObject({
        details: [{ path: 'scripts/setup.sh', issue: 'executable_content_prohibited' }],
      });
      expect(await tenantRows(tenantA)).toBe(before);
    });

    it('allowedTools outside the registry, empty instructions, key mismatches and invalid manifests are refused', async () => {
      const before = await tenantRows(tenantA);
      await expect(
        attempt({
          manifest: manifest('bad-tools', { allowedTools: ['brand.getSnapshot', 'shell.exec'] }),
          instructions: INSTRUCTIONS,
        }),
      ).rejects.toMatchObject({
        details: [{ path: 'manifest.allowedTools', issue: 'unknown_tool:shell.exec' }],
      });
      await expect(attempt({ manifest: manifest('empty'), instructions: '  \n' })).rejects.toMatchObject({
        details: [{ path: 'SKILL.md', issue: 'instructions_empty' }],
      });
      await expect(
        attempt({ skillId, manifest: manifest('other-key'), instructions: INSTRUCTIONS }),
      ).rejects.toMatchObject({ details: [{ path: 'manifest.key', issue: 'must match the skill key' }] });
      await expect(
        attempt({ skillKey: 'other', manifest: manifest('tenant-copy'), instructions: INSTRUCTIONS }),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(
        attempt({
          manifest: { ...manifest('big'), budgets: { ...manifest('big').budgets, maxSteps: 99 } },
          instructions: INSTRUCTIONS,
        }),
      ).rejects.toThrow();
      await expect(
        attempt({ scope: 'brand', manifest: manifest('no-brand'), instructions: INSTRUCTIONS }),
      ).rejects.toMatchObject({ details: [{ path: 'brandId', issue: 'required for brand scope' }] });
      await expect(
        attempt({ scope: 'platform', manifest: manifest('not-operator'), instructions: INSTRUCTIONS }),
      ).rejects.toMatchObject({ reason: 'platform_skill_read_only' });
      expect(await tenantRows(tenantA)).toBe(before);
    });
  });

  describe('tenant isolation (spec 5.3)', () => {
    it('foreign or mismatched ids are NOT_FOUND, never data, and nothing is written', async () => {
      const before = await tenantRows(tenantB);
      const B = manager(tenantB);
      await expect(
        runInTenant(ctx(tenantA), () => skillsService.get(A, { skillId: skillB })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runInTenant(ctx(tenantA), () => skillsService.export(A, { skillVersionId: versionB })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.create(
            A,
            createInput({ skillId: skillB, manifest: manifest('b-skill'), instructions: INSTRUCTIONS }),
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.evaluate(
            A,
            evaluateInput({ skillVersionId: versionB, expectedVersion: 0 }),
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.versions.publish(
            ADM,
            publishInput({ skillVersionId: versionB, expectedVersion: 0 }),
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.bindings.set(ADM, { scope: 'tenant', skillId: skillB, skillVersionId: versionB }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Own skill + a foreign version id.
      await expect(
        run(tenantA, (tx) =>
          skillsService.bindings.set(ADM, { scope: 'tenant', skillId, skillVersionId: versionB }, tx),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // A foreign brand id on list, import and bindings.
      await expect(
        runInTenant(ctx(tenantA), () => skillsService.list(A, { brandId: brandB, page: { limit: 50 } })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.import(
            A,
            importInput({
              files: [
                { path: 'SKILL.md', content: INSTRUCTIONS },
                { path: 'manifest.json', content: manifestJson(manifest('foreign-brand')) },
              ],
              scope: 'brand',
              brandId: brandB,
            }),
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        run(tenantA, (tx) =>
          skillsService.bindings.set(
            ADM,
            { scope: 'brand', brandId: brandB, skillId, skillVersionId: v1 },
            tx,
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        runInTenant(ctx(tenantA), () =>
          skillsService.resolveForRun(agent(tenantA), { brandId: brandB, taskKind: 'copywriting' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await tenantRows(tenantB)).toBe(before);
      // Tenant B still reaches its own rows and never sees tenant A's skill.
      const own = await runInTenant(ctx(tenantB), () => skillsService.get(B, { skillId: skillB }));
      expect(own.versions.map((v) => v.state)).toEqual(['draft']);
      const listB = await runInTenant(ctx(tenantB), () => skillsService.list(B, { page: { limit: 50 } }));
      expect(listB.items.map((s) => s.key)).not.toContain('tenant-copy');
    });

    it('a brand-scoped skill is invisible to an actor restricted to another brand of the same tenant', async () => {
      const created = await run(tenantA, (tx) =>
        skillsService.versions.create(
          A,
          createInput({
            scope: 'brand',
            brandId: brandA1,
            manifest: manifest('a1-only'),
            instructions: INSTRUCTIONS,
          }),
          tx,
        ),
      );
      await expect(
        runInTenant(ctx(tenantA, new Set([brandA2])), () =>
          skillsService.get(A, { skillId: created.skillId }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      const restricted = await runInTenant(ctx(tenantA, new Set([brandA2])), () =>
        skillsService.list(A, { page: { limit: 50 } }),
      );
      expect(restricted.items.map((s) => s.key)).not.toContain('a1-only');
      expect(restricted.items.map((s) => s.key)).toContain('tenant-copy');
      const all = await runInTenant(ctx(tenantA), () =>
        skillsService.list(A, { scope: 'brand', page: { limit: 50 } }),
      );
      expect(all.items.map((s) => s.key)).toEqual(['a1-only']);
      const page1 = await runInTenant(ctx(tenantA), () => skillsService.list(A, { page: { limit: 2 } }));
      expect(page1.items.length).toBe(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await runInTenant(ctx(tenantA), () =>
        skillsService.list(A, { page: { limit: 2, cursor: page1.nextCursor! } }),
      );
      expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    });
  });

  it('every mutation left an allowed audit event in the command transaction', async () => {
    const rows = await tdb.db.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantA));
    const actions = new Set(rows.filter((r) => r.decision === 'allowed').map((r) => r.action));
    for (const a of [
      'skill.version.create',
      'skill.version.evaluate',
      'skill.version.publish',
      'skill.version.rollout',
      'skill.binding.set',
      'skill.author',
      'skill.publish',
    ])
      expect(actions.has(a), a).toBe(true);
    expect(rows.every((r) => r.correlationId === 'corr_skill')).toBe(true);
    const failedEvaluation = rows.find(
      (r) => r.action === 'skill.version.evaluate' && r.metadata?.['reason'] === 'failed',
    )!;
    expect(failedEvaluation.metadata).toMatchObject({
      fromState: 'draft',
      toState: 'draft',
      reason: 'failed',
    });
    const denied = rows.filter((r) => r.decision === 'denied').map((r) => r.reason);
    expect(denied).toContain('agent_never');
    expect(denied).toContain('role_missing');
  });
});
