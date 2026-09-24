import type { CrossTenantFixture } from '../cross-tenant-inputs';
import { seedSkillManifest } from './skills-seed';

/** One entry per skills.* procedure, every id pointing at the foreign tenant's rows from SKILLS_SEED (spec 19.3). */
export const SKILLS_INPUTS: Record<string, CrossTenantFixture> = {
  'skills.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'skills.get': { buildInput: (f) => ({ skillId: f['skillId'] }) },
  'skills.versions.create': {
    buildInput: (f) => ({
      skillId: f['skillId'],
      manifest: seedSkillManifest(),
      instructions: '# x\n\nDo nothing.\n',
      references: [],
    }),
  },
  'skills.versions.evaluate': {
    buildInput: (f) => ({ skillVersionId: f['skillVersionId'], expectedVersion: 0 }),
  },
  'skills.versions.publish': {
    buildInput: (f) => ({ skillVersionId: f['skillVersionId'], expectedVersion: 0, rolloutPercent: 100 }),
  },
  'skills.bindings.set': {
    buildInput: (f) => ({
      scope: 'brand',
      brandId: f['brandId'],
      skillId: f['skillId'],
      skillVersionId: f['skillVersionId'],
    }),
  },
  'skills.import': {
    buildInput: (f) => ({
      files: [
        { path: 'SKILL.md', content: '# x\n\nDo nothing.\n' },
        { path: 'manifest.json', content: JSON.stringify(seedSkillManifest('imported-skill')) },
      ],
      scope: 'brand',
      brandId: f['brandId'],
    }),
  },
  'skills.export': { buildInput: (f) => ({ skillVersionId: f['skillVersionId'] }) },
};
