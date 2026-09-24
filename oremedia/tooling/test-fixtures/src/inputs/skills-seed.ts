import { and, eq, isNull } from 'drizzle-orm';
import type { EvaluationCase, SkillManifestV1 } from '@oremedia/contracts/skills';
import {
  evaluationResults,
  evaluationSuites,
  skillBindings,
  skillVersions,
  skills,
} from '@oremedia/db/schema/skills';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/** A minimal valid manifest (spec 10.1) for fixtures. */
export const seedSkillManifest = (key = 'seeded-skill'): SkillManifestV1 => ({
  schemaVersion: 1,
  key,
  title: 'Seeded skill',
  description: 'Fixture skill',
  taskKinds: ['copywriting'],
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  requiredContext: ['brand_snapshot'],
  allowedTools: ['brand.getSnapshot'],
  budgets: { maxSteps: 5, maxTokens: 1000, maxCostMicros: 1000, maxVariants: 1, deadlineSeconds: 60 },
  modelCompatibility: ['anthropic:*'],
  instructionsPath: 'SKILL.md',
});

const seedCases: EvaluationCase[] = [
  {
    id: 'seed-1',
    title: 'Seeded case',
    input: {},
    brandFixtureRef: 'fixture-brand',
    expected: { properties: ['schema_valid'] },
  },
];

const PLATFORM_KEY = 'seeded-platform-skill';

/**
 * Per tenant: one tenant-scoped skill with a draft version, its evaluation suite and result, and a binding on brand 1,
 * so a foreign caller has every skills id to try (spec 19.3). One platform skill (tenant_id NULL) is created once and
 * readable by both tenants; the skills integration test proves it is not editable by a tenant user.
 */
export const SKILLS_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const skillId = newId('skill');
  const skillVersionId = newId('skillVersion');
  const skillBindingId = newId('skillBinding');
  const evaluationSuiteId = newId('evaluationSuite');
  const evaluationResultId = newId('evaluationResult');
  const manifest = seedSkillManifest();
  const instructions = '# Seeded skill\n\nDo nothing.\n';
  await db.insert(skills).values({
    id: skillId,
    tenantId,
    scope: 'tenant',
    brandId: null,
    key: manifest.key,
    title: manifest.title,
    ownerUserId,
    state: 'active',
  });
  await db.insert(skillVersions).values({
    id: skillVersionId,
    tenantId,
    skillId,
    number: 1,
    manifest,
    instructions,
    references: {},
    packageHash: hashCanonical({ manifest, instructions, references: {} }),
    state: 'draft',
    rolloutPercent: 0,
  });
  await db.insert(evaluationSuites).values({
    id: evaluationSuiteId,
    tenantId,
    skillVersionId,
    cases: seedCases as never,
  });
  await db.insert(evaluationResults).values({
    id: evaluationResultId,
    tenantId,
    suiteId: evaluationSuiteId,
    skillVersionId,
    modelVersion: 'none',
    runs: 3,
    scores: {},
    variance: {},
    deterministicChecks: { 'seed-1/schema_valid': true },
    passed: true,
  });
  await db.insert(skillBindings).values({
    id: skillBindingId,
    tenantId,
    brandId: brandIds[0],
    skillVersionId,
    taskKind: 'copywriting',
    priority: 100,
  });
  let platform = (
    await db
      .select()
      .from(skills)
      .where(and(eq(skills.scope, 'platform'), isNull(skills.tenantId), eq(skills.key, PLATFORM_KEY)))
  )[0];
  let platformSkillVersionId: string;
  if (!platform) {
    const platformManifest = seedSkillManifest(PLATFORM_KEY);
    const platformSkillId = newId('skill');
    platformSkillVersionId = newId('skillVersion');
    await db.insert(skills).values({
      id: platformSkillId,
      tenantId: null,
      scope: 'platform',
      brandId: null,
      key: PLATFORM_KEY,
      title: platformManifest.title,
      state: 'active',
    });
    await db.insert(skillVersions).values({
      id: platformSkillVersionId,
      tenantId: null,
      skillId: platformSkillId,
      number: 1,
      manifest: platformManifest,
      instructions,
      references: {},
      packageHash: hashCanonical({ manifest: platformManifest, instructions, references: {} }),
      state: 'draft',
      rolloutPercent: 0,
    });
    platform = (await db.select().from(skills).where(eq(skills.id, platformSkillId)))[0];
  } else {
    platformSkillVersionId = (
      await db.select().from(skillVersions).where(eq(skillVersions.skillId, platform.id))
    )[0]!.id;
  }
  return {
    skillId,
    skillVersionId,
    skillBindingId,
    evaluationSuiteId,
    evaluationResultId,
    platformSkillId: platform!.id,
    platformSkillVersionId,
  };
};
