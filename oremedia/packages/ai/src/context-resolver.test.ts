import { describe, expect, it } from 'vitest';
import type { AssetRef } from '@oremedia/contracts/assets';
import { BudgetExhaustedError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { EntitlementSet, ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import type { ResolvedSkill } from '@oremedia/contracts/skills';
import type { AutonomyMode } from '@oremedia/contracts/tenancy';
import {
  DEFAULT_RUN_BUDGET,
  detectSkillConflicts,
  entitlementAutonomy,
  resolveAllowedTools,
  resolveBudget,
  resolveContextSnapshot,
  type ContextResolveInput,
  type ContextResolverDeps,
} from './context-resolver';
import { defaultEvaluationFixture } from './evaluation/fixtures';
import { createReleaseOneRegistry } from './tools';

const registry = createReleaseOneRegistry();
const brand = defaultEvaluationFixture().snapshot;

const skill = (
  allowedTools: string[],
  instructions = 'Do the work.',
  maxCostMicros = 400_000,
): ResolvedSkill => ({
  skillVersionId: `sv_${allowedTools.join('')}`,
  skillId: 'skl_1',
  key: 'test-skill',
  versionNumber: 1,
  manifest: {
    schemaVersion: 1,
    key: 'test-skill',
    title: 'Test',
    description: 'test',
    taskKinds: ['copywriting'],
    inputSchema: {},
    outputSchema: { type: 'object' },
    requiredContext: ['brand_snapshot', 'metrics'],
    allowedTools,
    budgets: { maxSteps: 8, maxTokens: 50_000, maxCostMicros, maxVariants: 4, deadlineSeconds: 900 },
    modelCompatibility: [],
    instructionsPath: 'SKILL.md',
  },
  instructions,
  references: [],
});

const principal = (
  maxAutonomy: AutonomyMode = 'create',
  grants = ['brand.read', 'asset.read', 'creative.edit'],
): ResolvedActorServicePrincipal => ({
  kind: 'service_principal',
  id: 'sp_1',
  tenantId: 'ten_A',
  status: 'active',
  maxAutonomy,
  grants: grants.map((action) => ({ action: action as never, brandIds: 'all' as const })),
});

const ent = (limit = 10_000_000, used = 0, managed = false): EntitlementSet => ({
  limits: { generation_budget_micros_month: limit },
  features: { managed_autopublish: managed },
  usage: { generation_budget_micros_month: used },
});

const assets: AssetRef[] = [
  {
    assetId: 'ast_b',
    assetVersionId: 'av_b',
    kind: 'photo',
    semanticRole: null,
    altText: null,
    contentHash: 'h',
    width: 1,
    height: 1,
  },
  {
    assetId: 'ast_a',
    assetVersionId: 'av_a',
    kind: 'photo',
    semanticRole: null,
    altText: null,
    contentHash: 'h',
    width: 1,
    height: 1,
  },
];

function deps(over: Partial<ContextResolverDeps> = {}): ContextResolverDeps {
  return {
    resolveBrandSnapshot: async () => brand,
    findEligibleAssets: async () => ({ items: assets }),
    resolveSkills: async () => [
      skill(['facts.list', 'assets.searchEligible', 'publications.proposeSchedule', 'no.such.tool']),
    ],
    tenantPolicy: async () => ({ maxAutonomy: 'managed_autopublish' }),
    resolveEntitlements: async () => ent(),
    registry,
    ...over,
  };
}
const input = (over: Partial<ContextResolveInput> = {}): ContextResolveInput => ({
  tenantId: 'ten_A',
  brandId: brand.brandId,
  runId: 'run_1',
  correlationId: 'corr_ctx',
  principal: principal(),
  requestedAutonomy: 'create',
  taskKind: 'copywriting',
  brief: { objective: 'x' },
  ...over,
});

describe('context resolver (spec 12.3)', () => {
  it('produces the same hash for the same inputs regardless of asset order, and a different hash when anything changes', async () => {
    const a = await resolveContextSnapshot(input(), deps());
    const b = await resolveContextSnapshot(
      input(),
      deps({ findEligibleAssets: async () => ({ items: [...assets].reverse() }) }),
    );
    expect(a.hash).toBe(b.hash);
    expect(a.eligibleAssets.map((x) => x.assetVersionId)).toEqual(['av_a', 'av_b']);
    const c = await resolveContextSnapshot(
      input(),
      deps({ findEligibleAssets: async () => ({ items: assets.slice(0, 1) }) }),
    );
    expect(c.hash).not.toBe(a.hash);
    const d = await resolveContextSnapshot(
      input({ brief: { evidence: [{ id: 'e1', sourceKind: 'comment', ref: 'x', text: 'hi' }] } }),
      deps(),
    );
    expect(d.hash).not.toBe(a.hash);
    expect(d.evidence[0]?.trust).toBe('untrusted');
  });

  it('allowedTools = skill allowlist ∩ grant-derived tools ∩ registry (a skill never widens grants)', async () => {
    const snapshot = await resolveContextSnapshot(input(), deps());
    // publications.proposeSchedule needs publication.schedule (not granted); no.such.tool is not registered
    expect(snapshot.policy.allowedTools).toEqual(['assets.searchEligible', 'facts.list']);
    expect(resolveAllowedTools([], principal(), brand.brandId, registry)).toEqual([]); // no skill, no tool
    expect(
      resolveAllowedTools([skill(['facts.list'])], principal('create', []), brand.brandId, registry),
    ).toEqual([]);
  });

  it('autonomy is min(requested, principal max, tenant policy, entitlement) and the model cannot raise it', async () => {
    const cases: Array<[AutonomyMode, AutonomyMode, AutonomyMode, boolean, AutonomyMode]> = [
      ['managed_autopublish', 'managed_autopublish', 'managed_autopublish', true, 'managed_autopublish'],
      ['managed_autopublish', 'managed_autopublish', 'managed_autopublish', false, 'prepare_release'],
      ['prepare_release', 'create', 'managed_autopublish', true, 'create'],
      ['create', 'managed_autopublish', 'assist', true, 'assist'],
      ['assist', 'managed_autopublish', 'managed_autopublish', true, 'assist'],
    ];
    for (const [requested, principalMax, tenantMax, managed, expected] of cases) {
      const snapshot = await resolveContextSnapshot(
        input({ requestedAutonomy: requested, principal: principal(principalMax) }),
        deps({
          tenantPolicy: async () => ({ maxAutonomy: tenantMax }),
          resolveEntitlements: async () => ent(10_000_000, 0, managed),
        }),
      );
      expect(snapshot.policy.autonomyMode).toBe(expected);
    }
    expect(entitlementAutonomy(ent(1, 0, false))).toBe('prepare_release');
  });

  it('budget is the minimum of the platform default, every skill manifest and the entitlement remainder', () => {
    expect(resolveBudget([], ent())).toEqual(DEFAULT_RUN_BUDGET);
    const b = resolveBudget(
      [skill(['facts.list'], 'x', 400_000), skill(['facts.list'], 'y', 300_000)],
      ent(10_000_000, 9_900_000),
    );
    expect(b).toEqual({
      maxSteps: 8,
      maxTokens: 50_000,
      maxCostMicros: 100_000,
      maxVariants: 4,
      deadlineSeconds: 900,
    });
    expect(() => resolveBudget([], ent(1_000_000, 1_000_000))).toThrow(BudgetExhaustedError);
  });

  it('surfaces a skill that mentions a prohibited phrase as a finding and reports context arriving later', () => {
    const findings = detectSkillConflicts(brand, [skill(['facts.list'], 'Call it cheap and cheerful.')]);
    expect(findings.map((f) => f.code)).toEqual(['skill_conflicts_with_brand', 'context_unavailable']);
    expect(findings[0]?.severity).toBe('warning');
  });

  it('rejects an unknown task kind and a malformed evidence list', async () => {
    await expect(resolveContextSnapshot(input({ taskKind: 'take_over' }), deps())).rejects.toThrow(
      ValidationFailedError,
    );
    await expect(
      resolveContextSnapshot(input({ brief: { evidence: [{ id: '' }] } }), deps()),
    ).rejects.toThrow(ValidationFailedError);
  });

  it('playbook is empty until the intelligence module supplies approved entries (Phase 6)', async () => {
    expect((await resolveContextSnapshot(input(), deps())).playbook).toEqual([]);
  });
});
