import { z } from 'zod';
import { EvidenceItem, type Budget } from '@oremedia/contracts/agents';
import type { AssetPurpose, AssetRef, EligibilityQuery } from '@oremedia/contracts/assets';
import type { BrandSnapshot, FactKind } from '@oremedia/contracts/brand';
import type { Finding } from '@oremedia/contracts/creative';
import { BudgetExhaustedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { PageRequest } from '@oremedia/contracts/pagination';
import type {
  EntitlementSet,
  ResolvedActor,
  ResolvedActorServicePrincipal,
} from '@oremedia/contracts/policy';
import { TaskKind, type ResolvedSkill } from '@oremedia/contracts/skills';
import { AutonomyMode } from '@oremedia/contracts/tenancy';
import { runAsPlatform, type Tx } from '@oremedia/db';
import { effectiveAutonomy } from '@oremedia/domain/autonomy';
import { hashCanonical } from '@oremedia/domain/hash';
import { UserDirectory } from '@oremedia/module-access';
import { assetService } from '@oremedia/module-assets';
import { entitlements } from '@oremedia/module-billing';
import { brandService } from '@oremedia/module-brand';
import type { ToolRegistry } from './tool-registry';

/** Spec 12.3 / 10.2: a skill pinned to an exact version for the run (contracts/skills, produced by resolveForRun). */
export type { ResolvedSkill };

export interface ApprovedFactRef {
  id: string;
  kind: FactKind;
  statement: string;
}

/** Approved playbook entries (spec 16.7); the intelligence module supplies them in Phase 6. Always [] until then. */
export interface PlaybookEntryRef {
  id: string;
  title: string;
}

export interface ContextSnapshot {
  hash: string;
  tenantId: string; // server-established; never from model output
  brandId: string;
  brand: BrandSnapshot; // section 8.3
  skills: ResolvedSkill[]; // pinned versions
  eligibleAssets: AssetRef[]; // already filtered by eligibility (section 9.2)
  facts: ApprovedFactRef[];
  playbook: PlaybookEntryRef[]; // approved entries only
  evidence: EvidenceItem[]; // retrieved docs/comments/web: labelled untrusted
  policy: { autonomyMode: AutonomyMode; allowedTools: string[]; budget: Budget };
  /** Conflicts between brand constraints and skill guidance, surfaced to the user (spec 10.3), never blended. */
  findings: Finding[];
}

export interface ContextResolveInput {
  tenantId: string;
  brandId: string;
  runId: string;
  correlationId: string;
  principal: ResolvedActorServicePrincipal;
  requestedAutonomy: AutonomyMode;
  taskKind: string;
  brief: Record<string, unknown>;
}

export type SkillResolver = (
  input: { tenantId: string; brandId: string; taskKind: TaskKind; actor: ResolvedActor },
  tx?: Tx,
) => Promise<ResolvedSkill[]>;

export type TenantPolicySource = (
  tenantId: string,
  correlationId: string,
  tx?: Tx,
) => Promise<{ maxAutonomy: AutonomyMode }>;

export interface ContextResolverDeps {
  resolveBrandSnapshot(actor: ResolvedActor, brandId: string, tx?: Tx): Promise<BrandSnapshot>;
  findEligibleAssets(query: EligibilityQuery, page: PageRequest, tx?: Tx): Promise<{ items: AssetRef[] }>;
  resolveSkills: SkillResolver;
  tenantPolicy: TenantPolicySource;
  resolveEntitlements(tenantId: string, tx?: Tx): Promise<EntitlementSet>;
  registry: ToolRegistry;
}

// ---- hooks filled by the composition root (same pattern as registerBrandChecker) ----

/** Until @oremedia/module-skills registers `skillsService.resolveForRun`, no skill is pinned and no tool is allowed. */
let skillResolver: SkillResolver = async () => [];
export const registerSkillResolver = (fn: SkillResolver): void => {
  skillResolver = fn;
};
export const resetSkillResolver = (): void => {
  skillResolver = async () => [];
};
export const resolveSkills: SkillResolver = (input, tx) => skillResolver(input, tx);

const directory = new UserDirectory();
/** tenants.policy.maxAutonomy (spec 12.5 "tenant policy"); absent = no tenant cap. */
let tenantPolicySource: TenantPolicySource = async (tenantId, correlationId, tx) => {
  const tenant = await runAsPlatform('agent-context', correlationId, () =>
    directory.tenantById(tenantId, tx),
  );
  const parsed = AutonomyMode.safeParse(tenant?.policy?.maxAutonomy);
  return { maxAutonomy: parsed.success ? parsed.data : 'managed_autopublish' };
};
export const registerTenantPolicySource = (fn: TenantPolicySource): void => {
  tenantPolicySource = fn;
};
export const tenantPolicyFor: TenantPolicySource = (tenantId, correlationId, tx) =>
  tenantPolicySource(tenantId, correlationId, tx);

export function defaultContextResolverDeps(registry: ToolRegistry): ContextResolverDeps {
  return {
    resolveBrandSnapshot: (actor, brandId, tx) => brandService.resolveBrandSnapshot(actor, { brandId }, tx),
    findEligibleAssets: (query, page, tx) => assetService.findEligibleAssets(query, page, tx),
    resolveSkills,
    tenantPolicy: tenantPolicyFor,
    resolveEntitlements: (tenantId, tx) => entitlements.resolve(tenantId, tx),
    registry,
  };
}

// ---- the min rules (spec 12.5, 12.6, 10.1) ----

/** Spec 12.5: the plan's entitlement caps autonomy; managed autopublish only when the plan includes it. */
export const entitlementAutonomy = (ent: EntitlementSet): AutonomyMode =>
  ent.features.managed_autopublish ? 'managed_autopublish' : 'prepare_release';

/** Platform ceiling for a run without a tighter skill budget (spec 12.6 limits per run come from manifests). */
export const DEFAULT_RUN_BUDGET: Budget = {
  maxSteps: 20,
  maxTokens: 200_000,
  maxCostMicros: 5_000_000, // USD 5
  maxVariants: 6,
  deadlineSeconds: 1800,
};

const minBudget = (a: Budget, b: Budget): Budget => ({
  maxSteps: Math.min(a.maxSteps, b.maxSteps),
  maxTokens: Math.min(a.maxTokens, b.maxTokens),
  maxCostMicros: Math.min(a.maxCostMicros, b.maxCostMicros),
  maxVariants: Math.min(a.maxVariants, b.maxVariants),
  deadlineSeconds: Math.min(a.deadlineSeconds, b.deadlineSeconds),
});

/** Budget = min(skill manifest budgets, entitlement remainder, platform default). Throws when the month is spent. */
export function resolveBudget(skills: readonly ResolvedSkill[], ent: EntitlementSet): Budget {
  let budget = DEFAULT_RUN_BUDGET;
  for (const s of skills) budget = minBudget(budget, s.manifest.budgets);
  const limit = ent.limits.generation_budget_micros_month ?? 0;
  const used = ent.usage.generation_budget_micros_month ?? 0;
  const remaining = limit - used;
  if (remaining <= 0) throw new BudgetExhaustedError('tenant_month');
  budget = { ...budget, maxCostMicros: Math.min(budget.maxCostMicros, remaining) };
  return z
    .object({
      maxSteps: z.number().int().min(1),
      maxTokens: z.number().int().min(1),
      maxCostMicros: z.number().int().min(0),
      maxVariants: z.number().int().min(1),
      deadlineSeconds: z.number().int().min(1),
    })
    .parse(budget);
}

/**
 * allowedTools = skills' allowlists ∩ tools the principal's grants cover for this brand ∩ the registry. A skill can
 * narrow, never widen (spec 10.1); no skill means no tool.
 */
export function resolveAllowedTools(
  skills: readonly ResolvedSkill[],
  principal: ResolvedActorServicePrincipal,
  brandId: string,
  registry: ToolRegistry,
): string[] {
  const fromSkills = new Set(skills.flatMap((s) => s.manifest.allowedTools));
  return registry.names().filter((name) => {
    if (!fromSkills.has(name)) return false;
    const def = registry.get(name);
    if (!def) return false;
    return principal.grants.some(
      (g) => g.action === def.action && (g.brandIds === 'all' || g.brandIds.includes(brandId)),
    );
  });
}

/** Spec 10.3: conflicts between brand constraints and skill guidance become run findings, never a silent blend. */
export function detectSkillConflicts(brand: BrandSnapshot, skills: readonly ResolvedSkill[]): Finding[] {
  const findings: Finding[] = [];
  const prohibited = [...brand.document.voice.prohibitedPhrases, ...brand.policy.prohibitedTerms]
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  for (const skill of skills) {
    const text = skill.instructions.toLowerCase();
    for (const phrase of prohibited) {
      if (text.includes(phrase))
        findings.push({
          code: 'skill_conflicts_with_brand',
          severity: 'warning',
          message: `Skill ${skill.key}@${skill.versionNumber} mentions the prohibited term "${phrase}"; brand constraints take precedence`,
        });
    }
    for (const ctx of skill.manifest.requiredContext) {
      if (ctx === 'metrics' || ctx === 'customer_voice' || ctx === 'playbook')
        findings.push({
          code: 'context_unavailable',
          severity: 'info',
          message: `Skill ${skill.key}@${skill.versionNumber} requires ${ctx}, which arrives in a later phase; the run proceeds without it`,
        });
    }
  }
  return findings;
}

/** Which eligibility purpose a task kind searches with (spec 9.2). */
export const purposeForTask = (taskKind: TaskKind): AssetPurpose =>
  taskKind === 'brand_onboarding' || taskKind === 'brand_review' ? 'reference' : 'creative';

const Brief = z.object({ evidence: z.array(EvidenceItem).max(50).optional() }).passthrough();

/** Deterministic bundle → hash (spec 12.3); the same inputs always give the same hash. */
export function hashContext(snapshot: Omit<ContextSnapshot, 'hash'>): string {
  return hashCanonical({
    tenantId: snapshot.tenantId,
    brandId: snapshot.brandId,
    brandHash: snapshot.brand.hash,
    skills: snapshot.skills.map((s) => s.skillVersionId).sort(),
    eligibleAssets: snapshot.eligibleAssets.map((a) => a.assetVersionId).sort(),
    facts: snapshot.facts.map((f) => f.id).sort(),
    playbook: snapshot.playbook.map((p) => p.id).sort(),
    evidence: snapshot.evidence.map((e) => ({ id: e.id, sourceKind: e.sourceKind, text: e.text })),
    policy: snapshot.policy,
  });
}

/**
 * Spec 12.3: everything an agent run is allowed to see and do, resolved server-side from the run's brand, the
 * principal's grants, the pinned skills, eligibility and the entitlement, then hashed. The model never supplies any
 * of it.
 */
export async function resolveContextSnapshot(
  input: ContextResolveInput,
  deps: ContextResolverDeps,
  tx?: Tx,
): Promise<ContextSnapshot> {
  const taskKind = TaskKind.safeParse(input.taskKind);
  if (!taskKind.success)
    throw new ValidationFailedError([{ path: 'taskKind', issue: `unknown task kind ${input.taskKind}` }]);
  const brief = Brief.safeParse(input.brief);
  if (!brief.success)
    throw new ValidationFailedError(
      brief.error.issues.map((i) => ({ path: `brief.${i.path.join('.')}`, issue: i.message })),
    );
  const brand = await deps.resolveBrandSnapshot(input.principal, input.brandId, tx); // policy brand.read for the principal
  const skills = await deps.resolveSkills(
    { tenantId: input.tenantId, brandId: input.brandId, taskKind: taskKind.data, actor: input.principal },
    tx,
  );
  const ent = await deps.resolveEntitlements(input.tenantId, tx);
  const tenantPolicy = await deps.tenantPolicy(input.tenantId, input.correlationId, tx);
  const autonomyMode = effectiveAutonomy(
    input.requestedAutonomy,
    input.principal.maxAutonomy,
    tenantPolicy.maxAutonomy,
    entitlementAutonomy(ent),
  );
  const eligible = await deps.findEligibleAssets(
    { brandId: input.brandId, purpose: purposeForTask(taskKind.data), channelConnectionIds: [] },
    { limit: 200 },
    tx,
  );
  const bundle: Omit<ContextSnapshot, 'hash'> = {
    tenantId: input.tenantId,
    brandId: input.brandId,
    brand,
    skills,
    eligibleAssets: [...eligible.items].sort((a, b) => a.assetVersionId.localeCompare(b.assetVersionId)),
    facts: brand.facts.map((f) => ({ id: f.id, kind: f.kind, statement: f.statement })),
    playbook: [], // approved playbook entries arrive with the intelligence module (Phase 6)
    evidence: (brief.data.evidence ?? []).map((e) => ({ ...e, trust: 'untrusted' as const })),
    policy: {
      autonomyMode,
      allowedTools: resolveAllowedTools(skills, input.principal, input.brandId, deps.registry),
      budget: resolveBudget(skills, ent),
    },
    findings: detectSkillConflicts(brand, skills),
  };
  return { ...bundle, hash: hashContext(bundle) };
}
