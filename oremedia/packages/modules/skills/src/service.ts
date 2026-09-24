import type { z } from 'zod';
import { NotFoundError, PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { Decision, ResolvedActor } from '@oremedia/contracts/policy';
import {
  EvaluationCase,
  EvaluationReport,
  SkillBindingSet,
  SkillEvaluationFail,
  SkillEvaluationRecord,
  SkillEvaluationRun,
  SkillExport,
  SkillGet,
  SkillImport,
  SkillList,
  SkillManifestV1,
  SkillVersionCreate,
  SkillVersionEvaluate,
  SkillVersionPublish,
  type ResolvedSkill,
  type SkillScope,
  type SkillVersionState,
  type TaskKind,
} from '@oremedia/contracts/skills';
import { requireTenant, runAsPlatform, type Tx } from '@oremedia/db';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { IllegalTransitionError, type StateMachine } from '@oremedia/domain/state-machines/machine';
import { skillVersionMachine } from '@oremedia/domain/state-machines/skill-version';
import { policy } from '@oremedia/module-access';
import { audit, outbox } from '@oremedia/module-operations';
import { logger } from '@oremedia/observability';
import { z as zod } from 'zod';
import {
  buildContent,
  packageHash,
  parsePackage,
  referencesToFiles,
  toPackage,
  type SkillPackageContent,
} from './package-format';
import {
  EvaluationResultRepository,
  EvaluationSuiteRepository,
  PlatformSkillRepository,
  SkillBindingRepository,
  SkillRepository,
  SkillVersionRepository,
  TENANT_WIDE_BRAND,
} from './repositories';

const skillsRepo = new SkillRepository();
const versionsRepo = new SkillVersionRepository();
const bindingsRepo = new SkillBindingRepository();
const suitesRepo = new EvaluationSuiteRepository();
const resultsRepo = new EvaluationResultRepository();
const platformRepo = new PlatformSkillRepository();

type SkillRow = Awaited<ReturnType<typeof skillsRepo.getById>>;
type VersionRow = Awaited<ReturnType<typeof versionsRepo.getById>>;
type BindingRow = Awaited<ReturnType<typeof bindingsRepo.getById>>;
type ResultRow = Awaited<ReturnType<typeof resultsRepo.getById>>;

// ---- cross-module hooks (same pattern as registerBrandChecker in the access module: modules never import each other's tables) ----
type BrandChecker = { assertExist(brandIds: string[], tx?: Tx): Promise<void> };
let brandChecker: BrandChecker | null = null;
export const registerBrandChecker = (c: BrandChecker): void => {
  brandChecker = c;
};
const brands = (): BrandChecker => {
  if (!brandChecker)
    throw new Error('brand checker not registered (composition root must call registerBrandChecker)');
  return brandChecker;
};

/**
 * Spec 19.6: the evaluation harness lives in the agent runtime; it registers the runner that grades a pinned version.
 * The runner is called by the worker (versions.runEvaluation) with no transaction open: model calls never hold a lock.
 */
export type EvaluationRunner = (input: {
  skillVersionId: string;
  manifest: SkillManifestV1;
  instructions: string;
  cases: EvaluationCase[];
  runs: number;
}) => Promise<EvaluationReport>;
let evaluationRunner: EvaluationRunner | null = null;
export const registerEvaluationRunner = (fn: EvaluationRunner): void => {
  evaluationRunner = fn;
};
const runner = (): EvaluationRunner => {
  if (!evaluationRunner)
    throw new Error(
      'evaluation runner not registered (the agent runtime must call registerEvaluationRunner)',
    );
  return evaluationRunner;
};

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });

/** Platform skills carry no tenant; for policy they are addressed in the caller's tenant (readable by every tenant). */
const skillResource = (s: SkillRow, extra?: { type?: string; id?: string; state?: string }) => {
  const { tenantId } = requireTenant();
  return {
    type: extra?.type ?? 'skill',
    tenantId,
    id: extra?.id ?? s.id,
    ...(s.brandId ? { brandId: s.brandId } : {}),
    ...(extra?.state ? { state: extra.state } : {}),
  };
};

/** Spec 5.5: agents never publish skills (policy denies skill.publish outright); belt and braces for propose_only. */
function assertMayDecide(decision: Decision): void {
  if (decision.obligations?.some((o) => o.type === 'propose_only'))
    throw new PolicyDeniedError('propose_only', 'Agents may only propose; a person must decide');
}

/** Platform (built-in) skills are readable by every tenant and editable only by a platform operator (escalated support session, spec 5.7). */
function assertMayEditScope(actor: ResolvedActor, scope: SkillScope): void {
  if (scope === 'platform' && actor.kind !== 'platform_operator')
    throw new PolicyDeniedError('platform_skill_read_only', 'Built-in skills are managed by the platform');
}

/** Same rule as BrandScopedRepository.assertBrandAccess: a brand the actor cannot see behaves like one that does not exist. */
function assertBrandVisible(brandId: string): void {
  const ctx = requireTenant();
  if (ctx.brandIds !== 'all' && !ctx.brandIds.has(brandId)) throw new NotFoundError('Brand', brandId);
}

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
function transition<S extends string, E extends string>(
  machine: StateMachine<S, E>,
  from: S,
  event: E,
  path: string,
): S {
  try {
    return machine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

/** A version is loaded through the scoped repository and bound to its (visible) skill: a foreign or invisible id is NOT_FOUND. */
async function loadVersion(versionId: string, tx?: Tx) {
  const version = await versionsRepo.getById(versionId, tx);
  const skill = await skillsRepo.findById(version.skillId, tx);
  if (!skill) throw new NotFoundError('SkillVersion', versionId);
  return { version, skill };
}

/**
 * Writes to a skill go through its scope's writer: tenant and brand skills through the scoped repositories,
 * platform skills through PlatformSkillRepository under runAsPlatform (only a platform operator gets this far).
 */
interface SkillWriter {
  lockSkill(id: string, tx: Tx): Promise<SkillRow>;
  updateSkill(
    id: string,
    expectedVersion: number,
    values: { activeVersionId: string | null },
    tx: Tx,
  ): Promise<void>;
  nextVersionNumber(skillId: string, tx: Tx): Promise<number>;
  createVersion(values: Parameters<typeof versionsRepo.create>[0], tx: Tx): Promise<void>;
  updateVersion(
    id: string,
    expectedVersion: number,
    values: Parameters<typeof versionsRepo.update>[2],
    tx: Tx,
  ): Promise<void>;
  createSuite(values: Parameters<typeof suitesRepo.create>[0], tx: Tx): Promise<void>;
  createResult(values: Parameters<typeof resultsRepo.create>[0], tx: Tx): Promise<void>;
}
const tenantWriter: SkillWriter = {
  lockSkill: (id, tx) => skillsRepo.lock(id, tx),
  updateSkill: (id, expectedVersion, values, tx) => skillsRepo.update(id, expectedVersion, values, tx),
  nextVersionNumber: (skillId, tx) => versionsRepo.nextNumber(skillId, tx),
  createVersion: (values, tx) => versionsRepo.create(values, tx),
  updateVersion: (id, expectedVersion, values, tx) => versionsRepo.update(id, expectedVersion, values, tx),
  createSuite: (values, tx) => suitesRepo.create(values, tx),
  createResult: (values, tx) => resultsRepo.create(values, tx),
};
const platformWriter: SkillWriter = {
  lockSkill: (id, tx) => platformRepo.lockSkill(id, tx),
  updateSkill: (id, expectedVersion, values, tx) => platformRepo.updateSkill(id, expectedVersion, values, tx),
  nextVersionNumber: (skillId, tx) => platformRepo.nextVersionNumber(skillId, tx),
  createVersion: (values, tx) => platformRepo.createVersion(values, tx),
  updateVersion: (id, expectedVersion, values, tx) =>
    platformRepo.updateVersion(id, expectedVersion, values, tx),
  createSuite: (values, tx) => platformRepo.createSuite(values, tx),
  createResult: (values, tx) => platformRepo.createResult(values, tx),
};
const writerFor = (scope: SkillScope): SkillWriter => (scope === 'platform' ? platformWriter : tenantWriter);
const inScope = <T>(scope: SkillScope, fn: () => Promise<T>): Promise<T> =>
  scope === 'platform' ? runAsPlatform('skill-platform-write', requireTenant().correlationId, fn) : fn();

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const References = zod.record(zod.string());

/** JSON documents are validated on read as well as on write (spec 6.1). */
const toSkillDto = (s: SkillRow) => ({
  id: s.id,
  scope: s.scope,
  brandId: s.brandId,
  key: s.key,
  title: s.title,
  state: s.state,
  activeVersionId: s.activeVersionId,
  ownerUserId: s.ownerUserId,
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
  version: s.version,
});
const toVersionSummary = (v: VersionRow) => ({
  id: v.id,
  skillId: v.skillId,
  number: v.number,
  state: v.state,
  rolloutPercent: v.rolloutPercent,
  packageHash: v.packageHash,
  publishedAt: iso(v.publishedAt),
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
  version: v.version,
});
const contentOf = (v: VersionRow): SkillPackageContent => ({
  manifest: SkillManifestV1.parse(v.manifest),
  instructions: v.instructions,
  references: References.parse(v.references),
});
const toBindingDto = (b: BindingRow) => ({
  id: b.id,
  scope: b.brandId === TENANT_WIDE_BRAND ? ('tenant' as const) : ('brand' as const),
  brandId: b.brandId === TENANT_WIDE_BRAND ? null : b.brandId,
  skillVersionId: b.skillVersionId,
  taskKind: b.taskKind,
  priority: b.priority,
  createdAt: b.createdAt.toISOString(),
  version: b.version,
});
const toResultDto = (r: ResultRow) => ({
  id: r.id,
  suiteId: r.suiteId,
  skillVersionId: r.skillVersionId,
  modelVersion: r.modelVersion,
  runs: r.runs,
  scores: zod.record(zod.number()).parse(r.scores),
  variance: zod.record(zod.number()).parse(r.variance),
  deterministicChecks: zod.record(zod.boolean()).parse(r.deterministicChecks),
  passed: r.passed,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Spec 10.2 rollout %: the bucket is derived from run-independent inputs only, so a brand always resolves the same
 * version for a given skill version (stable across retries, replays and runs). bucket = first 32 bits of
 * hashCanonical({ tenantId, brandId, skillId, versionNumber }) mod 100; the version is served when bucket < rolloutPercent.
 */
export function rolloutBucket(input: {
  tenantId: string;
  brandId: string;
  skillId: string;
  versionNumber: number;
}): number {
  return parseInt(hashCanonical(input).slice(0, 8), 16) % 100;
}

/**
 * Spec 19.6: deterministic checks decide; a model-graded score never replaces them. Every expected property of every
 * case must be reported as passed, every expected rubric dimension must reach its minimum, and the runner's own
 * verdict must agree. Scores and variances are flattened per `${caseId}/${dimension}` for the result row.
 */
function scoreReport(cases: EvaluationCase[], report: EvaluationReport) {
  const deterministicChecks: Record<string, boolean> = {};
  const scores: Record<string, number> = {};
  const variance: Record<string, number> = {};
  let passed = true;
  for (const c of cases) {
    const cr = report.cases.find((r) => r.caseId === c.id);
    for (const p of c.expected.properties) {
      const ok = cr?.deterministic.some((d) => d.check === p && d.passed) === true;
      deterministicChecks[`${c.id}/${p}`] = ok;
      if (!ok) passed = false;
    }
    for (const r of cr?.rubric ?? []) {
      scores[`${c.id}/${r.dimension}`] = r.mean;
      variance[`${c.id}/${r.dimension}`] = r.variance;
    }
    for (const dim of c.expected.rubric ?? []) {
      const r = cr?.rubric.find((x) => x.dimension === dim.dimension);
      if (!r || r.mean < dim.minScore) passed = false;
    }
    if (!cr?.passed) passed = false;
  }
  return { passed, deterministicChecks, scores, variance };
}

/**
 * Finds or creates the skill for a validated package in the requested scope and appends the next version as a draft.
 * Every version pins its content (manifest, SKILL.md, references) and package hash; content never changes afterwards.
 */
async function createVersion(
  actor: ResolvedActor,
  input: {
    skillId?: string | undefined;
    scope: SkillScope;
    brandId?: string | undefined;
    content: SkillPackageContent;
    cases?: EvaluationCase[] | undefined;
  },
  tx: Tx,
) {
  const { tenantId } = requireTenant();
  const { content } = input;
  let skill: SkillRow | null = null;
  let scope = input.scope;
  let brandId: string | null = input.brandId ?? null;
  if (input.skillId) {
    skill = await skillsRepo.getById(input.skillId, tx);
    if (skill.key !== content.manifest.key)
      throw new ValidationFailedError([{ path: 'manifest.key', issue: 'must match the skill key' }]);
    scope = skill.scope;
    brandId = skill.brandId;
  } else {
    if (scope === 'brand' && !brandId)
      throw new ValidationFailedError([{ path: 'brandId', issue: 'required for brand scope' }]);
    if (scope !== 'brand' && brandId)
      throw new ValidationFailedError([{ path: 'brandId', issue: 'only allowed for brand scope' }]);
    if (brandId) {
      assertBrandVisible(brandId);
      await brands().assertExist([brandId], tx);
    }
    skill = await skillsRepo.findByKey(scope, brandId, content.manifest.key, tx);
  }
  await policy.assert(
    actor,
    'skill.author',
    skill ? skillResource(skill) : { type: 'skill', tenantId, ...(brandId ? { brandId } : {}) },
    {},
    tx,
  );
  assertMayEditScope(actor, scope);
  const writer = writerFor(scope);
  return inScope(scope, async () => {
    if (!skill) {
      const id = newId('skill');
      const values = {
        id,
        scope,
        brandId,
        key: content.manifest.key,
        title: content.manifest.title,
        ownerUserId: actor.kind === 'user' ? actor.id : null,
        state: 'active' as const,
      };
      if (scope === 'platform') await platformRepo.createSkill(values, tx);
      else await skillsRepo.create(values, tx);
      skill = await writer.lockSkill(id, tx);
    } else {
      skill = await writer.lockSkill(skill.id, tx);
    }
    const versionId = newId('skillVersion');
    const number = await writer.nextVersionNumber(skill.id, tx);
    const hash = packageHash(content);
    await writer.createVersion(
      {
        id: versionId,
        skillId: skill.id,
        number,
        manifest: content.manifest,
        instructions: content.instructions,
        references: content.references,
        packageHash: hash,
        state: 'draft',
        rolloutPercent: 0,
      },
      tx,
    );
    let suiteId: string | null = null;
    if (input.cases && input.cases.length) {
      suiteId = newId('evaluationSuite');
      await writer.createSuite({ id: suiteId, skillVersionId: versionId, cases: input.cases }, tx);
    }
    await audit.record(
      actorRef(actor),
      'skill.version.create',
      { type: 'skill_version', id: versionId },
      'allowed',
      tx,
      { scope, ...(brandId ? { brandId } : {}) },
    );
    return {
      skillId: skill.id,
      key: skill.key,
      skillVersionId: versionId,
      number,
      packageHash: hash,
      suiteId,
      version: 0,
    };
  });
}

export const skillsService = {
  /** Skills visible to the actor: platform built-ins, the tenant's own and the brand skills of brands they may see. */
  async list(actor: ResolvedActor, input: z.infer<typeof SkillList>, tx?: Tx) {
    const parsed = SkillList.parse(input);
    const { tenantId } = requireTenant();
    if (parsed.brandId) {
      assertBrandVisible(parsed.brandId);
      await brands().assertExist([parsed.brandId], tx);
    }
    await policy.assert(
      actor,
      'skill.read',
      { type: 'skill', tenantId, ...(parsed.brandId ? { brandId: parsed.brandId } : {}) },
      {},
      tx,
    );
    const page = await skillsRepo.list({ scope: parsed.scope, brandId: parsed.brandId }, parsed.page, tx);
    return { items: page.items.map(toSkillDto), nextCursor: page.nextCursor };
  },

  /** A skill with its versions (summaries), the bindings the actor may see and recent evaluation results. */
  async get(actor: ResolvedActor, input: z.infer<typeof SkillGet>, tx?: Tx) {
    const parsed = SkillGet.parse(input);
    const skill = await skillsRepo.getById(parsed.skillId, tx);
    if (skill.brandId) assertBrandVisible(skill.brandId);
    await policy.assert(actor, 'skill.read', skillResource(skill), {}, tx);
    const versions = await versionsRepo.listForSkill(skill.id, tx);
    const versionIds = versions.map((v) => v.id);
    const bindings = await bindingsRepo.listVisibleForVersions(versionIds, tx);
    const results = await resultsRepo.listForVersions(versionIds, tx);
    return {
      ...toSkillDto(skill),
      versions: versions.map(toVersionSummary),
      bindings: bindings.map(toBindingDto),
      evaluations: results.map(toResultDto),
    };
  },

  versions: {
    /** Spec 10.1: validates the manifest, the tool allowlist and the declarative-only rule, then stores a pinned draft. */
    async create(actor: ResolvedActor, input: z.infer<typeof SkillVersionCreate>, tx: Tx) {
      const parsed = SkillVersionCreate.parse(input);
      const content = buildContent(parsed.manifest, parsed.instructions, parsed.references);
      if (parsed.skillKey && parsed.skillKey !== content.manifest.key)
        throw new ValidationFailedError([{ path: 'skillKey', issue: 'must match manifest.key' }]);
      return createVersion(
        actor,
        {
          skillId: parsed.skillId,
          scope: parsed.scope,
          brandId: parsed.brandId,
          content,
          cases: parsed.cases,
        },
        tx,
      );
    },

    /**
     * Spec 10.2 / 19.6: draft → sandbox_evaluation. The evaluation itself is sandbox work: the command only picks or
     * creates the suite, moves the version and emits skill.evaluation_requested; the worker runs the suite
     * (runEvaluation) with no transaction open and records the report (recordEvaluation), as renders do.
     */
    async evaluate(actor: ResolvedActor, input: z.infer<typeof SkillVersionEvaluate>, tx: Tx) {
      const parsed = SkillVersionEvaluate.parse(input);
      const { version, skill } = await loadVersion(parsed.skillVersionId, tx);
      await policy.assert(
        actor,
        'skill.author',
        skillResource(skill, { type: 'skill_version', id: version.id, state: version.state }),
        {},
        tx,
      );
      assertMayEditScope(actor, skill.scope);
      const toState = transition(skillVersionMachine, version.state, 'start_evaluation', 'skillVersionId');
      const writer = writerFor(skill.scope);
      return inScope(skill.scope, async () => {
        let suiteId: string;
        if (parsed.cases) {
          suiteId = newId('evaluationSuite');
          await writer.createSuite({ id: suiteId, skillVersionId: version.id, cases: parsed.cases }, tx);
        } else {
          const suite = await suitesRepo.findLatestForVersion(version.id, tx);
          if (!suite)
            throw new ValidationFailedError(
              [{ path: 'cases', issue: 'no_evaluation_cases' }],
              'This version has no evaluation cases',
            );
          suiteId = suite.id;
        }
        await writer.updateVersion(version.id, parsed.expectedVersion, { state: toState }, tx);
        await audit.record(
          actorRef(actor),
          'skill.version.evaluate',
          { type: 'skill_version', id: version.id },
          'allowed',
          tx,
          {
            fromState: version.state,
            toState,
            reason: 'requested',
            ...(skill.brandId ? { brandId: skill.brandId } : {}),
          },
        );
        await outbox.add(
          'skill.evaluation_requested',
          { type: 'skill_version', id: version.id, version: parsed.expectedVersion + 1 },
          {
            skillVersionId: version.id,
            skillId: skill.id,
            suiteId,
            runs: parsed.runs,
            actorKind: actor.kind,
            actorId: actor.id,
          },
          tx,
          skill.brandId ? { brandId: skill.brandId } : undefined,
        );
        return { skillVersionId: version.id, suiteId, state: toState, version: parsed.expectedVersion + 1 };
      });
    },

    /**
     * Evaluation worker, step 1: the registered runner grades the pinned content against the suite. No transaction
     * is open while the model is called. The report is null (nothing to run) when the version has already left
     * the sandbox, so a re-delivered event burns no model budget.
     */
    async runEvaluation(
      input: z.infer<typeof SkillEvaluationRun>,
    ): Promise<{ skillVersionId: string; state: SkillVersionState; report: EvaluationReport | null }> {
      const parsed = SkillEvaluationRun.parse(input);
      const { version } = await loadVersion(parsed.skillVersionId);
      const suite = await suitesRepo.getById(parsed.suiteId);
      if (suite.skillVersionId !== version.id) throw new NotFoundError('EvaluationSuite', parsed.suiteId);
      if (version.state !== 'sandbox_evaluation') {
        logger()
          .child('skills')
          .info({ skillVersionId: version.id, state: version.state }, 'evaluation not run');
        return { skillVersionId: version.id, state: version.state, report: null };
      }
      const content = contentOf(version);
      const report = EvaluationReport.parse(
        await runner()({
          skillVersionId: version.id,
          manifest: content.manifest,
          instructions: content.instructions,
          cases: EvaluationCase.array().parse(suite.cases),
          runs: parsed.runs,
        }),
      );
      if (report.skillVersionId !== version.id)
        throw new ValidationFailedError([
          { path: 'report.skillVersionId', issue: 'evaluation_report_mismatch' },
        ]);
      return { skillVersionId: version.id, state: version.state, report };
    },

    /**
     * Evaluation worker, step 2 (one short transaction): sandbox_evaluation → in_review (passed) or back to draft
     * (failed). The report is scored deterministically and stored as an insert-only result. A version that already
     * left the sandbox (recorded by an earlier attempt, or moved meanwhile) is left alone: a retried activity is a no-op.
     */
    async recordEvaluation(input: z.infer<typeof SkillEvaluationRecord>, tx: Tx) {
      const parsed = SkillEvaluationRecord.parse(input);
      const { version, skill } = await loadVersion(parsed.skillVersionId, tx);
      const suite = await suitesRepo.getById(parsed.suiteId, tx);
      if (suite.skillVersionId !== version.id) throw new NotFoundError('EvaluationSuite', parsed.suiteId);
      if (version.state !== 'sandbox_evaluation') {
        logger()
          .child('skills')
          .info({ skillVersionId: version.id, state: version.state }, 'evaluation not recorded');
        return {
          outcome: 'skipped' as const,
          skillVersionId: version.id,
          state: version.state,
          version: version.version,
        };
      }
      if (parsed.report.skillVersionId !== version.id)
        throw new ValidationFailedError([
          { path: 'report.skillVersionId', issue: 'evaluation_report_mismatch' },
        ]);
      const cases = EvaluationCase.array().parse(suite.cases);
      const outcome = scoreReport(cases, parsed.report);
      const toState = transition(
        skillVersionMachine,
        version.state,
        outcome.passed ? 'evaluation_passed' : 'evaluation_failed',
        'skillVersionId',
      );
      const writer = writerFor(skill.scope);
      return inScope(skill.scope, async () => {
        const resultId = newId('evaluationResult');
        await writer.createResult(
          {
            id: resultId,
            suiteId: suite.id,
            skillVersionId: version.id,
            modelVersion: parsed.report.gradedBy
              ? `${parsed.report.gradedBy.provider}:${parsed.report.gradedBy.model}`
              : 'none',
            runs: parsed.report.runs,
            scores: outcome.scores,
            variance: outcome.variance,
            deterministicChecks: outcome.deterministicChecks,
            passed: outcome.passed,
          },
          tx,
        );
        await writer.updateVersion(version.id, version.version, { state: toState }, tx);
        await audit.record(
          requireTenant().actor,
          'skill.version.evaluate',
          { type: 'skill_version', id: version.id },
          'allowed',
          tx,
          {
            fromState: version.state,
            toState,
            reason: outcome.passed ? 'passed' : 'failed',
            ...(skill.brandId ? { brandId: skill.brandId } : {}),
          },
        );
        await outbox.add(
          'skill.version_evaluated',
          { type: 'skill_version', id: version.id, version: version.version + 1 },
          {
            skillVersionId: version.id,
            skillId: skill.id,
            suiteId: suite.id,
            resultId,
            passed: outcome.passed,
            toState,
          },
          tx,
          skill.brandId ? { brandId: skill.brandId } : undefined,
        );
        return {
          outcome: 'recorded' as const,
          skillVersionId: version.id,
          suiteId: suite.id,
          resultId,
          passed: outcome.passed,
          state: toState,
          version: version.version + 1,
        };
      });
    },

    /**
     * Evaluation worker, failure path (as renders' markFailed): the run could not complete (model outage after
     * retries, a lost permission), so sandbox_evaluation → draft with no result row; the reason is audited and
     * published. A version that already left the sandbox is left alone (a re-delivered fail is a no-op).
     */
    async failEvaluation(input: z.infer<typeof SkillEvaluationFail>, tx: Tx) {
      const parsed = SkillEvaluationFail.parse(input);
      const { version, skill } = await loadVersion(parsed.skillVersionId, tx);
      const suite = await suitesRepo.getById(parsed.suiteId, tx);
      if (suite.skillVersionId !== version.id) throw new NotFoundError('EvaluationSuite', parsed.suiteId);
      if (version.state !== 'sandbox_evaluation') {
        logger()
          .child('skills')
          .info({ skillVersionId: version.id, state: version.state }, 'evaluation not failed');
        return {
          outcome: 'skipped' as const,
          skillVersionId: version.id,
          state: version.state,
          version: version.version,
        };
      }
      const toState = transition(skillVersionMachine, version.state, 'evaluation_failed', 'skillVersionId');
      const error = parsed.reason.slice(0, 500);
      const writer = writerFor(skill.scope);
      return inScope(skill.scope, async () => {
        await writer.updateVersion(version.id, version.version, { state: toState }, tx);
        await audit.record(
          requireTenant().actor,
          'skill.version.evaluate',
          { type: 'skill_version', id: version.id },
          'allowed',
          tx,
          {
            fromState: version.state,
            toState,
            reason: 'failed',
            error,
            ...(skill.brandId ? { brandId: skill.brandId } : {}),
          },
        );
        await outbox.add(
          'skill.version_evaluated',
          { type: 'skill_version', id: version.id, version: version.version + 1 },
          {
            skillVersionId: version.id,
            skillId: skill.id,
            suiteId: suite.id,
            resultId: null,
            passed: false,
            toState,
            error,
          },
          tx,
          skill.brandId ? { brandId: skill.brandId } : undefined,
        );
        return {
          outcome: 'failed' as const,
          skillVersionId: version.id,
          suiteId: suite.id,
          state: toState,
          version: version.version + 1,
        };
      });
    },

    /**
     * Spec 10.2: in_review → published (rollout %) once the latest evaluation of this exact version passed. Publishing
     * makes the version the skill's active version (the binding at the skill's own scope) and never retires earlier
     * published versions, so a rollback can bind one of them later. On an already published version only the rollout
     * percentage changes.
     */
    async publish(actor: ResolvedActor, input: z.infer<typeof SkillVersionPublish>, tx: Tx) {
      const parsed = SkillVersionPublish.parse(input);
      const { version, skill } = await loadVersion(parsed.skillVersionId, tx);
      const decision = await policy.assert(
        actor,
        'skill.publish',
        skillResource(skill, { type: 'skill_version', id: version.id, state: version.state }),
        {},
        tx,
      );
      assertMayDecide(decision);
      assertMayEditScope(actor, skill.scope);
      const writer = writerFor(skill.scope);
      if (version.state === 'published') {
        await inScope(skill.scope, () =>
          writer.updateVersion(
            version.id,
            parsed.expectedVersion,
            { rolloutPercent: parsed.rolloutPercent },
            tx,
          ),
        );
        await audit.record(
          actorRef(actor),
          'skill.version.rollout',
          { type: 'skill_version', id: version.id },
          'allowed',
          tx,
          { count: parsed.rolloutPercent, ...(skill.brandId ? { brandId: skill.brandId } : {}) },
        );
        return {
          skillVersionId: version.id,
          number: version.number,
          state: version.state,
          rolloutPercent: parsed.rolloutPercent,
          version: parsed.expectedVersion + 1,
        };
      }
      const toState = transition(skillVersionMachine, version.state, 'publish', 'skillVersionId');
      const latest = await resultsRepo.findLatestForVersion(version.id, tx);
      if (!latest || !latest.passed)
        throw new ValidationFailedError(
          [{ path: 'skillVersionId', issue: 'evaluation_required' }],
          'A passing evaluation of this version is required before publishing',
        );
      return inScope(skill.scope, async () => {
        const locked = await writer.lockSkill(skill.id, tx);
        await writer.updateVersion(
          version.id,
          parsed.expectedVersion,
          { state: toState, rolloutPercent: parsed.rolloutPercent, publishedAt: new Date() },
          tx,
        );
        await writer.updateSkill(locked.id, locked.version, { activeVersionId: version.id }, tx);
        await audit.record(
          actorRef(actor),
          'skill.version.publish',
          { type: 'skill_version', id: version.id },
          'allowed',
          tx,
          { fromState: version.state, toState, ...(skill.brandId ? { brandId: skill.brandId } : {}) },
        );
        await outbox.add(
          'skill.version_published',
          { type: 'skill_version', id: version.id, version: parsed.expectedVersion + 1 },
          {
            skillVersionId: version.id,
            skillId: skill.id,
            number: version.number,
            rolloutPercent: parsed.rolloutPercent,
            packageHash: version.packageHash,
            previousActiveVersionId: locked.activeVersionId,
          },
          tx,
          skill.brandId ? { brandId: skill.brandId } : undefined,
        );
        return {
          skillVersionId: version.id,
          number: version.number,
          state: toState,
          rolloutPercent: parsed.rolloutPercent,
          version: parsed.expectedVersion + 1,
        };
      });
    },
  },

  bindings: {
    /**
     * Precedence brand > tenant > platform (spec 10.3 resolver). At the skill's own scope the binding is
     * skills.active_version_id; narrower scopes are skill_bindings rows (tenant scope under TENANT_WIDE_BRAND).
     * A null version unbinds; an earlier published version is a rollback and affects future runs only.
     */
    async set(actor: ResolvedActor, input: z.infer<typeof SkillBindingSet>, tx: Tx) {
      const parsed = SkillBindingSet.parse(input);
      const skill = await skillsRepo.getById(parsed.skillId, tx);
      const order: Record<SkillScope, number> = { platform: 0, tenant: 1, brand: 2 };
      if (order[parsed.scope] < order[skill.scope])
        throw new ValidationFailedError([{ path: 'scope', issue: 'scope_wider_than_skill' }]);
      let brandId: string | null = null;
      if (parsed.scope === 'brand') {
        if (!parsed.brandId)
          throw new ValidationFailedError([{ path: 'brandId', issue: 'required for brand scope' }]);
        if (skill.scope === 'brand' && skill.brandId !== parsed.brandId)
          throw new ValidationFailedError([{ path: 'brandId', issue: 'must match the brand skill' }]);
        assertBrandVisible(parsed.brandId);
        await brands().assertExist([parsed.brandId], tx);
        brandId = parsed.brandId;
      } else if (parsed.brandId) {
        throw new ValidationFailedError([{ path: 'brandId', issue: 'only allowed for brand scope' }]);
      }
      const { tenantId } = requireTenant();
      const decision = await policy.assert(
        actor,
        'skill.publish',
        { type: 'skill_binding', tenantId, id: skill.id, ...(brandId ? { brandId } : {}) },
        {},
        tx,
      );
      assertMayDecide(decision);
      if (parsed.scope === 'platform') assertMayEditScope(actor, 'platform');
      let version: VersionRow | null = null;
      if (parsed.skillVersionId !== null) {
        version = await versionsRepo.getById(parsed.skillVersionId, tx);
        if (version.skillId !== skill.id) throw new NotFoundError('SkillVersion', parsed.skillVersionId);
        if (version.state !== 'published')
          throw new ValidationFailedError(
            [{ path: 'skillVersionId', issue: 'version_not_published' }],
            'Only a published version can be bound',
          );
      }
      let previousVersionId: string | null;
      if (parsed.scope === skill.scope) {
        previousVersionId = skill.activeVersionId;
        await inScope(skill.scope, async () => {
          const locked = await writerFor(skill.scope).lockSkill(skill.id, tx);
          await writerFor(skill.scope).updateSkill(
            locked.id,
            locked.version,
            { activeVersionId: version ? version.id : null },
            tx,
          );
        });
      } else {
        const brandKey = brandId ?? TENANT_WIDE_BRAND;
        const versionIds = (await versionsRepo.listForSkill(skill.id, tx)).map((v) => v.id);
        const existing = await bindingsRepo.listForVersions(brandKey, versionIds, tx);
        previousVersionId = existing[0]?.skillVersionId ?? null;
        for (const b of existing) await bindingsRepo.remove(b.id, tx);
        if (version) {
          const manifest = SkillManifestV1.parse(version.manifest);
          for (const taskKind of manifest.taskKinds)
            await bindingsRepo.create(
              {
                id: newId('skillBinding'),
                brandId: brandKey,
                skillVersionId: version.id,
                taskKind,
                priority: 100,
              },
              tx,
            );
        }
      }
      await audit.record(
        actorRef(actor),
        'skill.binding.set',
        { type: 'skill', id: skill.id },
        'allowed',
        tx,
        {
          scope: parsed.scope,
          reason: version ? (version.id === previousVersionId ? 'unchanged' : 'bound') : 'unbound',
          ...(brandId ? { brandId } : {}),
        },
      );
      return {
        skillId: skill.id,
        scope: parsed.scope,
        brandId,
        skillVersionId: version ? version.id : null,
        previousVersionId,
      };
    },
  },

  /** Spec 10.1: imports an Agent Skills package; governance (state, rollout, bindings) stays in the registry. */
  async import(actor: ResolvedActor, input: z.infer<typeof SkillImport>, tx: Tx) {
    const parsed = SkillImport.parse(input);
    const content = parsePackage(parsed.files);
    return createVersion(
      actor,
      { scope: parsed.scope, brandId: parsed.brandId, content, cases: parsed.cases },
      tx,
    );
  },

  /** The same package shape back: SKILL.md, canonical manifest.json and the references, exactly as pinned. */
  async export(actor: ResolvedActor, input: z.infer<typeof SkillExport>, tx?: Tx) {
    const parsed = SkillExport.parse(input);
    const { version, skill } = await loadVersion(parsed.skillVersionId, tx);
    if (skill.brandId) assertBrandVisible(skill.brandId);
    await policy.assert(
      actor,
      'skill.read',
      skillResource(skill, { type: 'skill_version', id: version.id, state: version.state }),
      {},
      tx,
    );
    return {
      skillVersionId: version.id,
      skillId: skill.id,
      key: skill.key,
      number: version.number,
      packageHash: version.packageHash,
      files: toPackage(contentOf(version)),
    };
  },

  /**
   * Spec 12.3: the pinned skill versions a run on `brandId` for `taskKind` uses, deterministic per run. For every
   * active visible skill the effective version is the first published one in precedence order brand binding >
   * tenant binding > the skill's active version; the rollout gate (rolloutBucket) then either keeps that version or
   * falls back to the newest other published version that passes its own gate. Drafts are never returned.
   */
  async resolveForRun(
    actor: ResolvedActor,
    input: { brandId: string; taskKind: TaskKind },
    tx?: Tx,
  ): Promise<ResolvedSkill[]> {
    const { tenantId } = requireTenant();
    assertBrandVisible(input.brandId);
    await brands().assertExist([input.brandId], tx);
    await policy.assert(
      actor,
      'brand.read',
      { type: 'brand', tenantId, brandId: input.brandId, id: input.brandId },
      {},
      tx,
    );
    const candidates = await skillsRepo.listActiveForBrand(input.brandId, tx);
    const brandBindings = await bindingsRepo.listFor(input.brandId, input.taskKind, tx);
    const tenantBindings = await bindingsRepo.listFor(TENANT_WIDE_BRAND, input.taskKind, tx);
    const boundVersions = new Map(
      (
        await versionsRepo.findMany(
          [...brandBindings, ...tenantBindings].map((b) => b.skillVersionId),
          tx,
        )
      ).map((v) => [v.id, v]),
    );
    const resolved: ResolvedSkill[] = [];
    for (const skill of candidates) {
      const published = (await versionsRepo.listForSkill(skill.id, tx)).filter(
        (v) => v.state === 'published',
      );
      const serves = (v: VersionRow) =>
        SkillManifestV1.parse(v.manifest).taskKinds.includes(input.taskKind) &&
        rolloutBucket({ tenantId, brandId: input.brandId, skillId: skill.id, versionNumber: v.number }) <
          v.rolloutPercent;
      const preferredIds = [
        ...brandBindings.filter((b) => boundVersions.get(b.skillVersionId)?.skillId === skill.id),
        ...tenantBindings.filter((b) => boundVersions.get(b.skillVersionId)?.skillId === skill.id),
      ].map((b) => b.skillVersionId);
      if (skill.activeVersionId) preferredIds.push(skill.activeVersionId);
      const preferred = preferredIds
        .map((id) => published.find((v) => v.id === id))
        .find((v) => v !== undefined);
      if (!preferred || !SkillManifestV1.parse(preferred.manifest).taskKinds.includes(input.taskKind))
        continue;
      const chosen = serves(preferred)
        ? preferred
        : published.find((v) => v.id !== preferred.id && serves(v));
      if (!chosen) continue;
      const content = contentOf(chosen);
      resolved.push({
        skillVersionId: chosen.id,
        skillId: skill.id,
        key: skill.key,
        versionNumber: chosen.number,
        manifest: content.manifest,
        instructions: content.instructions,
        references: referencesToFiles(content.references),
      });
    }
    return resolved;
  },
};
