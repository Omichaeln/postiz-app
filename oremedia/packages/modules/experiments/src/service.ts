import type { z } from 'zod';
import { PolicyDeniedError, ValidationFailedError } from '@oremedia/contracts/errors';
import {
  ExperimentAssign,
  ExperimentCreate,
  ExperimentGet,
  ExperimentList,
  ExperimentPreRegister,
  ExperimentResults,
  ExperimentResultsGet,
  ExperimentStart,
  ExperimentStop,
  PreRegistrationV1,
  conclusionLabelFor,
} from '@oremedia/contracts/experiments';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import { requireTenant, type Tx } from '@oremedia/db';
import { assignVariant } from '@oremedia/domain/experiments/index';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { experimentMachine, type ExperimentEvent } from '@oremedia/domain/state-machines/experiment';
import { IllegalTransitionError } from '@oremedia/domain/state-machines/machine';
import { policy } from '@oremedia/module-access';
import { brandService } from '@oremedia/module-brand';
import { contentService } from '@oremedia/module-content';
import { audit, featureFlag, outbox } from '@oremedia/module-operations';
import { analyseExperiment } from './analysis';
import { experimentArmLinks, notifyExperiment } from './hooks';
import {
  ExperimentAssignmentRepository,
  ExperimentRepository,
  ExperimentResultRepository,
  ExperimentVariantRepository,
} from './repositories';

const experimentsRepo = new ExperimentRepository();
const variantsRepo = new ExperimentVariantRepository();
const assignmentsRepo = new ExperimentAssignmentRepository();
const resultsRepo = new ExperimentResultRepository();

type ExperimentRow = Awaited<ReturnType<typeof experimentsRepo.getById>>;
type VariantRow = Awaited<ReturnType<typeof variantsRepo.getById>>;
type ResultRow = Awaited<ReturnType<typeof resultsRepo.getById>>;

const actorRef = (actor: ResolvedActor) => ({ kind: actor.kind, id: actor.id });
const brandResource = (brandId: string) => {
  const { tenantId } = requireTenant();
  return { type: 'brand', tenantId, brandId, id: brandId };
};
const experimentResource = (x: ExperimentRow) => ({
  type: 'experiment',
  tenantId: x.tenantId,
  brandId: x.brandId,
  id: x.id,
  state: x.state,
});

/** Spec 13.1: state is written only by transition(); an illegal move is rejected as a validation failure. */
function transition(from: ExperimentRow['state'], event: ExperimentEvent, path: string) {
  try {
    return experimentMachine.transition(from, event);
  } catch (err) {
    if (err instanceof IllegalTransitionError)
      throw new ValidationFailedError(
        [{ path, issue: err.message }],
        'This change is not allowed in the current state',
      );
    throw err;
  }
}

/** Spec 16.6 pre-registration: the design as it will be frozen, built from the row and its variants. */
function designOf(x: ExperimentRow, variants: VariantRow[]): PreRegistrationV1 {
  const stored = x.preRegistration;
  return PreRegistrationV1.parse({
    v: 1,
    hypothesis: x.hypothesis,
    mode: x.mode,
    variants: variants.map((v) => ({
      label: v.label,
      contentRevisionId: v.contentRevisionId,
      allocationWeight: v.allocationWeight,
    })),
    primaryMetricKey: x.primaryMetricKey,
    guardrailMetricKeys: x.guardrailMetricKeys,
    guardrailThresholds:
      stored?.guardrailThresholds ?? (x.stoppingRule['guardrailThresholds'] as object) ?? {},
    ...(stored?.guardrailDirections !== undefined
      ? { guardrailDirections: stored.guardrailDirections }
      : x.stoppingRule['guardrailDirections'] !== undefined
        ? { guardrailDirections: x.stoppingRule['guardrailDirections'] }
        : {}),
    allocationMethod: x.allocationMethod,
    unitType: stored?.unitType ?? (x.stoppingRule['unitType'] as string) ?? 'visitor',
    minSamplePerArm: x.minSample.perArm,
    observationWindowHours: x.observationWindowHours.hours,
    stoppingRule: stored?.stoppingRule ?? x.stoppingRule['rule'],
    ...(stored?.winsorisePercentile !== undefined
      ? { winsorisePercentile: stored.winsorisePercentile }
      : x.stoppingRule['winsorisePercentile'] !== undefined
        ? { winsorisePercentile: x.stoppingRule['winsorisePercentile'] }
        : {}),
  });
}

const toExperimentDto = (x: ExperimentRow, variants: VariantRow[]) => ({
  id: x.id,
  brandId: x.brandId,
  recommendationId: x.recommendationId,
  hypothesis: x.hypothesis,
  mode: x.mode,
  conclusionLabel: conclusionLabelFor(x.mode),
  primaryMetricKey: x.primaryMetricKey,
  guardrailMetricKeys: x.guardrailMetricKeys,
  allocationMethod: x.allocationMethod,
  minSamplePerArm: x.minSample.perArm,
  observationWindowHours: x.observationWindowHours.hours,
  variants: variants.map((v) => ({
    id: v.id,
    label: v.label,
    contentRevisionId: v.contentRevisionId,
    allocationWeight: v.allocationWeight,
  })),
  preRegistration: x.preRegistration ? PreRegistrationV1.parse(x.preRegistration) : null,
  preRegistrationHash: x.preRegistrationHash,
  preRegisteredAt: x.preRegisteredAt ? x.preRegisteredAt.toISOString() : null,
  state: x.state,
  startedAt: x.startedAt ? x.startedAt.toISOString() : null,
  stoppedAt: x.stoppedAt ? x.stoppedAt.toISOString() : null,
  createdByKind: x.createdByKind,
  createdById: x.createdById,
  createdAt: x.createdAt.toISOString(),
  updatedAt: x.updatedAt.toISOString(),
  version: x.version,
});
const toResultDto = (r: ResultRow, mode: ExperimentRow['mode']) => ({
  id: r.id,
  experimentId: r.experimentId,
  computedAt: r.computedAt.toISOString(),
  preRegistrationHash: r.preRegistrationHash,
  perVariant: r.perVariant,
  estimate: r.estimate,
  interval: r.intervalLow !== null && r.intervalHigh !== null ? [r.intervalLow, r.intervalHigh] : null,
  pValue: r.pValue,
  guardrailBreached: r.guardrailBreached,
  verdict: r.verdict,
  verdictReason: r.verdictReason,
  methodVersion: r.methodVersion,
  conclusionLabel: conclusionLabelFor(mode),
});

async function loadWithVariants(experimentId: string, tx?: Tx) {
  const x = await experimentsRepo.getById(experimentId, tx);
  const variants = await variantsRepo.listForExperiment(x.brandId, x.id, tx);
  return { x, variants };
}

/** A variant's revision must exist in this brand (NOT_FOUND for a foreign one, spec 5.3). */
async function assertRevisionsInBrand(brandId: string, variants: VariantRow[], tx: Tx) {
  for (const [i, v] of variants.entries()) {
    if (!v.contentRevisionId)
      throw new ValidationFailedError([
        { path: `variants.${i}.contentRevisionId`, issue: 'a content revision is required to pre-register' },
      ]);
    const revision = await contentService.revisions.read(v.contentRevisionId, tx);
    if (revision.brandId !== brandId)
      throw new ValidationFailedError([
        { path: `variants.${i}.contentRevisionId`, issue: 'revision_not_in_brand' },
      ]);
  }
}

export const experimentsService = {
  /**
   * Spec 16.6: a designed experiment (draft) with its variants. Agents propose designs whose revisions may still
   * be blank; pre-registration is where every reference is verified and the design is frozen.
   */
  async create(
    actor: ResolvedActor,
    input: z.infer<typeof ExperimentCreate>,
    tx: Tx,
    opts: { autonomyMode?: AutonomyMode } = {},
  ) {
    const parsed = ExperimentCreate.parse(input);
    const brand = await brandService.get(actor, parsed.brandId, tx);
    // An agent proposes a draft under its run's autonomy mode (spec 12.4 propose_only); a person needs no mode.
    await policy.assert(actor, 'experiment.manage', brandResource(brand.id), opts, tx);
    const d = parsed.design;
    if (d.allocationMethod === 'hashed_visitor' && d.unitType !== 'visitor')
      throw new ValidationFailedError([
        { path: 'design.unitType', issue: 'hashed_visitor assigns visitors' },
      ]);
    if (d.mode === 'structured_comparison' && d.allocationMethod === 'hashed_visitor')
      throw new ValidationFailedError([
        {
          path: 'design.allocationMethod',
          issue: 'a structured comparison uses matched slots, not visitors',
        },
      ]);
    const labels = new Set(d.variants.map((v) => v.label));
    if (labels.size !== d.variants.length)
      throw new ValidationFailedError([{ path: 'design.variants', issue: 'variant labels must be unique' }]);
    const id = newId('experiment');
    await experimentsRepo.create(
      {
        id,
        brandId: brand.id,
        recommendationId: parsed.recommendationId ?? null,
        hypothesis: d.hypothesis,
        mode: d.mode,
        primaryMetricKey: d.primaryMetricKey,
        guardrailMetricKeys: d.guardrailMetricKeys,
        allocationMethod: d.allocationMethod,
        minSample: { perArm: d.minSamplePerArm },
        observationWindowHours: { hours: d.observationWindowHours },
        // The parts of the design without a column of their own, until the design is frozen as a whole.
        stoppingRule: {
          rule: d.stoppingRule,
          unitType: d.unitType,
          guardrailThresholds: d.guardrailThresholds,
          ...(d.guardrailDirections !== undefined ? { guardrailDirections: d.guardrailDirections } : {}),
          ...(d.winsorisePercentile !== undefined ? { winsorisePercentile: d.winsorisePercentile } : {}),
        },
        preRegistration: null,
        preRegistrationHash: null,
        preRegisteredAt: null,
        state: 'designed',
        startedAt: null,
        stoppedAt: null,
        createdByKind: actor.kind === 'user' ? 'user' : 'agent',
        createdById: actor.id,
      },
      tx,
    );
    for (const v of d.variants)
      await variantsRepo.create(
        {
          id: newId('experimentVariant'),
          brandId: brand.id,
          experimentId: id,
          label: v.label,
          contentRevisionId: v.contentRevisionId,
          allocationWeight: v.allocationWeight,
        },
        tx,
      );
    await audit.record(actorRef(actor), 'experiment.create', { type: 'experiment', id }, 'allowed', tx, {
      brandId: brand.id,
      toState: 'designed',
    });
    return { experimentId: id, state: 'designed' as const, version: 0 };
  },

  /**
   * Spec 16.6 pre-registration (mandatory baseline): hypothesis, variants, metrics, allocation, unit, minimum
   * sample, window and stopping rule are frozen with a hash. Results computed against a different hash are
   * rejected. A person pre-registers; an agent only proposes (spec 12.4 experiments.proposeDesign).
   */
  async preRegister(actor: ResolvedActor, input: z.infer<typeof ExperimentPreRegister>, tx: Tx) {
    const parsed = ExperimentPreRegister.parse(input);
    const x = await experimentsRepo.lock(parsed.experimentId, tx);
    await policy.assert(actor, 'experiment.manage', experimentResource(x), {}, tx);
    if (actor.kind !== 'user')
      throw new PolicyDeniedError('agent_never', 'A person pre-registers an experiment');
    const toState = transition(x.state, 'pre_register', 'experimentId');
    const variants = await variantsRepo.listForExperiment(x.brandId, x.id, tx);
    await assertRevisionsInBrand(x.brandId, variants, tx);
    const design = designOf(x, variants);
    const preRegistrationHash = hashCanonical(design);
    const now = new Date();
    await experimentsRepo.update(
      x.id,
      parsed.expectedVersion,
      { preRegistration: design, preRegistrationHash, preRegisteredAt: now, state: toState },
      tx,
    );
    await audit.record(
      actorRef(actor),
      'experiment.pre_register',
      { type: 'experiment', id: x.id },
      'allowed',
      tx,
      {
        brandId: x.brandId,
        fromState: x.state,
        toState,
        hash: preRegistrationHash,
      },
    );
    await notifyExperiment(
      {
        kind: 'pre_registered',
        tenantId: x.tenantId,
        brandId: x.brandId,
        experimentId: x.id,
        recommendationId: x.recommendationId,
        preRegistrationHash,
        mode: x.mode,
      },
      tx,
    );
    return { experimentId: x.id, state: toState, preRegistrationHash, version: parsed.expectedVersion + 1 };
  },

  /** pre_registered → running; a randomised experiment needs the experiments.randomised flag (spec 22.1). */
  async start(actor: ResolvedActor, input: z.infer<typeof ExperimentStart>, tx: Tx) {
    const parsed = ExperimentStart.parse(input);
    const x = await experimentsRepo.lock(parsed.experimentId, tx);
    await policy.assert(actor, 'experiment.manage', experimentResource(x), {}, tx);
    if (actor.kind !== 'user') throw new PolicyDeniedError('agent_never', 'A person starts an experiment');
    if (x.mode === 'randomised' && !(await featureFlag.isEnabled('experiments.randomised', x.tenantId, tx)))
      throw new PolicyDeniedError(
        'feature_flag_off',
        'Randomised experiments are not enabled for this company',
      );
    const toState = transition(x.state, 'start', 'experimentId');
    const now = new Date();
    await experimentsRepo.update(x.id, parsed.expectedVersion, { state: toState, startedAt: now }, tx);
    await audit.record(actorRef(actor), 'experiment.start', { type: 'experiment', id: x.id }, 'allowed', tx, {
      brandId: x.brandId,
      fromState: x.state,
      toState,
    });
    await outbox.add(
      'experiment.started',
      { type: 'experiment', id: x.id, version: parsed.expectedVersion + 1 },
      { experimentId: x.id, mode: x.mode, preRegistrationHash: x.preRegistrationHash },
      tx,
      { brandId: x.brandId },
    );
    const variants = await variantsRepo.listForExperiment(x.brandId, x.id, tx);
    // Spec 16.6: a hashed-visitor experiment gets one tracked link per arm (the arm's revision names its URL) and
    // an entry link; the redirector assigns visitors on the entry link and records exposures on the arm links.
    const links = experimentArmLinks();
    let entryLink: { shortCode: string; shortUrl: string | null } | null = null;
    if (links && x.allocationMethod === 'hashed_visitor') {
      const arms = [];
      for (const v of variants)
        arms.push({
          variantId: v.id,
          text: (await contentService.revisions.read(v.contentRevisionId, tx)).copy.master.text,
        });
      const created = await links.create({ brandId: x.brandId, experimentId: x.id, arms }, tx);
      if (created) entryLink = { shortCode: created.entryShortCode, shortUrl: created.shortUrl };
    }
    await notifyExperiment(
      {
        kind: 'started',
        tenantId: x.tenantId,
        brandId: x.brandId,
        experimentId: x.id,
        recommendationId: x.recommendationId,
        preRegistrationHash: x.preRegistrationHash,
        mode: x.mode,
        executedRevisionId: variants[1]?.contentRevisionId ?? null,
      },
      tx,
    );
    return { experimentId: x.id, state: toState, version: parsed.expectedVersion + 1, entryLink };
  },

  async stop(actor: ResolvedActor, input: z.infer<typeof ExperimentStop>, tx: Tx) {
    const parsed = ExperimentStop.parse(input);
    const x = await experimentsRepo.lock(parsed.experimentId, tx);
    await policy.assert(actor, 'experiment.manage', experimentResource(x), {}, tx);
    const toState = transition(x.state, 'stop', 'experimentId');
    await experimentsRepo.update(x.id, parsed.expectedVersion, { state: toState, stoppedAt: new Date() }, tx);
    await audit.record(actorRef(actor), 'experiment.stop', { type: 'experiment', id: x.id }, 'allowed', tx, {
      brandId: x.brandId,
      fromState: x.state,
      toState,
      reason: parsed.reason ?? null,
    });
    await notifyExperiment(
      {
        kind: 'stopped',
        tenantId: x.tenantId,
        brandId: x.brandId,
        experimentId: x.id,
        recommendationId: x.recommendationId,
        preRegistrationHash: x.preRegistrationHash,
        mode: x.mode,
      },
      tx,
    );
    return { experimentId: x.id, state: toState, version: parsed.expectedVersion + 1 };
  },

  /**
   * Spec 16.6 analysis against the frozen design. Rejected when the caller's hash is not the frozen one (the
   * design changed), and never declared before the pre-registered sample and window are reached unless the
   * pre-registered stopping rule is the always-valid sequential test. The verdict comes from the decision rule in
   * analysis.ts; a guardrail breach makes a primary win not_supported; inconclusive is a normal outcome.
   */
  async results(actor: ResolvedActor, input: z.infer<typeof ExperimentResults>, tx: Tx) {
    const parsed = ExperimentResults.parse(input);
    const x = await experimentsRepo.lock(parsed.experimentId, tx);
    await policy.assert(actor, 'experiment.manage', experimentResource(x), {}, tx);
    if (x.state !== 'running' && x.state !== 'stopped')
      throw new ValidationFailedError([
        { path: 'experimentId', issue: `experiment is ${x.state}, not running or stopped` },
      ]);
    if (!x.preRegistration || !x.preRegistrationHash || !x.startedAt)
      throw new ValidationFailedError([{ path: 'experimentId', issue: 'not_pre_registered' }]);
    const design = PreRegistrationV1.parse(x.preRegistration);
    // Both the caller's stated design and the stored document must still hash to the frozen value.
    if (
      parsed.preRegistrationHash !== x.preRegistrationHash ||
      hashCanonical(design) !== x.preRegistrationHash
    )
      throw new ValidationFailedError(
        [{ path: 'preRegistrationHash', issue: 'design_changed' }],
        'Results are computed only against the pre-registered design',
      );
    const variants = await variantsRepo.listForExperiment(x.brandId, x.id, tx);
    const variantIds = new Set(variants.map((v) => v.id));
    for (const [i, o] of parsed.observations.entries())
      if (!variantIds.has(o.variantId))
        throw new ValidationFailedError([{ path: `observations.${i}.variantId`, issue: 'unknown_variant' }]);
    const at = parsed.at ? new Date(parsed.at) : new Date();
    const sequential = design.stoppingRule.kind === 'sequential_msprt';
    const windowEnd = new Date(x.startedAt.getTime() + design.observationWindowHours * 3600_000);
    const windowReached = at.getTime() >= windowEnd.getTime();
    const sampleReached = variants.every(
      (v) => (parsed.observations.find((o) => o.variantId === v.id)?.n ?? 0) >= design.minSamplePerArm,
    );
    if (!sequential && !(windowReached && sampleReached))
      throw new ValidationFailedError(
        [
          {
            path: 'at',
            issue: windowReached ? 'window_reached' : `window_not_reached_until_${windowEnd.toISOString()}`,
          },
          {
            path: 'observations',
            issue: sampleReached ? 'sample_reached' : `sample_below_${design.minSamplePerArm}_per_arm`,
          },
        ],
        'Results are not declared before the pre-registered sample and window are reached',
      );
    // Spec 16.6: a link experiment's exposure per arm is what the redirector recorded (distinct visitors on the
    // arm's link); a caller-stated exposure is kept as given.
    const links = experimentArmLinks();
    const exposures =
      links && x.allocationMethod === 'hashed_visitor' ? await links.exposures(x.brandId, x.id, tx) : null;
    const observations = parsed.observations.map((o) => {
      const exposure = exposures?.get(o.variantId);
      return o.exposure === undefined && exposure !== undefined ? { ...o, exposure } : o;
    });
    const outcome = analyseExperiment(
      design,
      variants.map((v) => v.id),
      observations,
    );
    const resultId = newId('experimentResult');
    await resultsRepo.create(
      {
        id: resultId,
        brandId: x.brandId,
        experimentId: x.id,
        computedAt: at,
        preRegistrationHash: x.preRegistrationHash,
        perVariant: outcome.perVariant,
        estimate: outcome.estimate,
        intervalLow: outcome.intervalLow,
        intervalHigh: outcome.intervalHigh,
        pValue: outcome.pValue,
        guardrailBreached: outcome.guardrailBreached,
        verdict: outcome.verdict,
        verdictReason: outcome.verdictReason.slice(0, 200),
        methodVersion: outcome.methodVersion.slice(0, 40),
      },
      tx,
    );
    // A sequential rule that did not reject keeps the experiment running; every other analysis is final.
    const final = !sequential || outcome.verdict !== 'inconclusive' || x.state === 'stopped';
    const toState = final ? transition(x.state, 'analyse', 'experimentId') : x.state;
    if (final)
      await experimentsRepo.update(x.id, x.version, { state: toState, stoppedAt: x.stoppedAt ?? at }, tx);
    await audit.record(
      actorRef(actor),
      'experiment.analyse',
      { type: 'experiment', id: x.id },
      'allowed',
      tx,
      {
        brandId: x.brandId,
        fromState: x.state,
        toState,
        reason: outcome.verdictReason.slice(0, 200),
        hash: x.preRegistrationHash,
      },
    );
    if (final)
      await notifyExperiment(
        {
          kind: 'analysed',
          tenantId: x.tenantId,
          brandId: x.brandId,
          experimentId: x.id,
          recommendationId: x.recommendationId,
          preRegistrationHash: x.preRegistrationHash,
          mode: x.mode,
          resultId,
          verdict: outcome.verdict,
          verdictReason: outcome.verdictReason,
        },
        tx,
      );
    return {
      resultId,
      experimentId: x.id,
      state: toState,
      verdict: outcome.verdict,
      verdictReason: outcome.verdictReason,
      conclusionLabel: conclusionLabelFor(x.mode),
      estimate: outcome.estimate,
      interval:
        outcome.intervalLow !== null && outcome.intervalHigh !== null
          ? [outcome.intervalLow, outcome.intervalHigh]
          : null,
      pValue: outcome.pValue,
      guardrailBreached: outcome.guardrailBreached,
      perVariant: outcome.perVariant,
      methodVersion: outcome.methodVersion,
      version: final ? x.version + 1 : x.version,
    };
  },

  async resultsGet(actor: ResolvedActor, input: z.infer<typeof ExperimentResultsGet>, tx?: Tx) {
    const parsed = ExperimentResultsGet.parse(input);
    const x = await experimentsRepo.getById(parsed.experimentId, tx);
    await policy.assert(actor, 'insight.read', experimentResource(x), {}, tx);
    const rows = await resultsRepo.listForExperiment(x.brandId, x.id, tx);
    return { experimentId: x.id, state: x.state, items: rows.map((r) => toResultDto(r, x.mode)) };
  },

  /**
   * Spec 16.6 randomised link experiments: the redirector hands a per-tenant-salted visitor hash; the arm comes
   * from the shared pure function (assignVariant) and the first assignment is recorded (insert-only, idempotent).
   */
  async assign(actor: ResolvedActor, input: z.infer<typeof ExperimentAssign>, tx: Tx) {
    const parsed = ExperimentAssign.parse(input);
    const x = await experimentsRepo.getById(parsed.experimentId, tx);
    await policy.assert(actor, 'insight.read', experimentResource(x), {}, tx);
    if (x.state !== 'running')
      throw new ValidationFailedError([
        { path: 'experimentId', issue: `experiment is ${x.state}, not running` },
      ]);
    const variants = await variantsRepo.listForExperiment(x.brandId, x.id, tx);
    const existing = await assignmentsRepo.find(x.brandId, x.id, parsed.unitType, parsed.unitIdHash, tx);
    const variantId =
      existing?.variantId ??
      assignVariant(
        parsed.unitIdHash,
        x.id,
        [...variants]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((v) => ({ id: v.id, allocationWeight: v.allocationWeight })),
      );
    if (!existing)
      await assignmentsRepo.create(
        {
          id: newId('experimentAssignment'),
          brandId: x.brandId,
          experimentId: x.id,
          unitType: parsed.unitType,
          unitIdHash: parsed.unitIdHash,
          variantId,
          assignedAt: new Date(),
        },
        tx,
      );
    const variant = variants.find((v) => v.id === variantId);
    return {
      experimentId: x.id,
      variantId,
      contentRevisionId: variant?.contentRevisionId ?? null,
      existing: !!existing,
    };
  },

  async get(actor: ResolvedActor, input: z.infer<typeof ExperimentGet>, tx?: Tx) {
    const parsed = ExperimentGet.parse(input);
    const { x, variants } = await loadWithVariants(parsed.experimentId, tx);
    await policy.assert(actor, 'insight.read', experimentResource(x), {}, tx);
    return toExperimentDto(x, variants);
  },

  async list(actor: ResolvedActor, input: z.infer<typeof ExperimentList>, tx?: Tx) {
    const parsed = ExperimentList.parse(input);
    const brand = await brandService.get(actor, parsed.brandId, tx);
    await policy.assert(actor, 'insight.read', brandResource(brand.id), {}, tx);
    const page = await experimentsRepo.list(brand.id, parsed.state, parsed.page, tx);
    const items = [];
    for (const x of page.items)
      items.push(toExperimentDto(x, await variantsRepo.listForExperiment(x.brandId, x.id, tx)));
    return { items, nextCursor: page.nextCursor };
  },

  /** Module-internal read for the intelligence workspace (tenant and brand scope from the context). */
  async listForBrand(brandId: string, tx?: Tx) {
    const rows = await experimentsRepo.listForBrand(brandId, tx);
    const out = [];
    for (const x of rows) {
      const results = await resultsRepo.listForExperiment(x.brandId, x.id, tx);
      out.push({
        ...toExperimentDto(x, await variantsRepo.listForExperiment(x.brandId, x.id, tx)),
        latestResult: results[0] ? toResultDto(results[0], x.mode) : null,
      });
    }
    return out;
  },
};
