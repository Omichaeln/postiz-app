import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvaluationCase, type SkillFile } from '@oremedia/contracts/skills';
import { runAsPlatform, withTransaction, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import {
  INSTRUCTIONS_PATH,
  MANIFEST_PATH,
  packageHash,
  parsePackage,
  type SkillPackageContent,
} from './package-format';
import { PlatformSkillRepository } from './repositories';

/** Spec 10.4: the Release 1 built-in skills, one directory each under packages/modules/skills/builtin. */
export const BUILTIN_SKILL_KEYS = [
  'brand-onboarding',
  'campaign-planning',
  'brand-copywriting',
  'social-layout',
  'channel-adaptation',
  'brand-review',
  'performance-review',
  'experiment-design',
] as const;
export type BuiltinSkillKey = (typeof BUILTIN_SKILL_KEYS)[number];

export interface BuiltinSkill extends SkillPackageContent {
  key: BuiltinSkillKey;
  packageHash: string;
  cases: EvaluationCase[];
}

/** Bundled builds ship the packages next to the bundle and set OREMEDIA_BUILTIN_SKILLS_DIR (as migrations do). */
export const builtinSkillsDir = (): string =>
  process.env['OREMEDIA_BUILTIN_SKILLS_DIR'] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'builtin');

async function readTree(base: string, dir: string): Promise<SkillFile[]> {
  const entries = await readdir(path.join(base, dir), { withFileTypes: true });
  const files: SkillFile[] = [];
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) files.push(...(await readTree(base, rel)));
    else files.push({ path: rel, content: await readFile(path.join(base, rel), 'utf8') });
  }
  return files;
}

/** Reads and validates every built-in package from disk (SKILL.md + manifest.json + references/* + cases/*.json). */
export async function loadBuiltinSkills(dir = builtinSkillsDir()): Promise<BuiltinSkill[]> {
  const out: BuiltinSkill[] = [];
  for (const key of BUILTIN_SKILL_KEYS) {
    const base = path.join(dir, key);
    if (!(await stat(base).catch(() => null))?.isDirectory())
      throw new Error(`built-in skill ${key}: directory missing at ${base}`);
    const all = await readTree(base, '');
    const cases = all
      .filter((f) => f.path.startsWith('cases/') && f.path.endsWith('.json'))
      .flatMap((f) => {
        const parsed: unknown = JSON.parse(f.content);
        return EvaluationCase.array().parse(Array.isArray(parsed) ? parsed : [parsed]);
      });
    const files = all.filter((f) => !f.path.startsWith('cases/'));
    if (!files.some((f) => f.path === INSTRUCTIONS_PATH) || !files.some((f) => f.path === MANIFEST_PATH))
      throw new Error(`built-in skill ${key}: SKILL.md and manifest.json are required`);
    const content = parsePackage(files);
    if (content.manifest.key !== key)
      throw new Error(`built-in skill ${key}: manifest.key is ${content.manifest.key}`);
    if (cases.length < 2)
      throw new Error(`built-in skill ${key}: at least two evaluation cases are required`);
    out.push({ key, ...content, packageHash: packageHash(content), cases });
  }
  return out;
}

const platformRepo = new PlatformSkillRepository();

/**
 * Registers the built-ins as platform skills with version 1 in `draft` and their evaluation cases as a suite.
 * Publishing needs a passing evaluation (spec 10.2), so nothing is auto-published. Idempotent by key: a skill that
 * already exists is skipped, never rewritten (a changed package becomes a new version through the service).
 */
export async function seedBuiltinSkills(
  tx?: Tx,
  opts: { correlationId?: string; dir?: string } = {},
): Promise<{ seeded: string[]; skipped: string[] }> {
  const builtins = await loadBuiltinSkills(opts.dir);
  return runAsPlatform('seed-builtin-skills', opts.correlationId ?? 'seed-builtin-skills', () =>
    withTransaction(tx, async (t) => {
      const seeded: string[] = [];
      const skipped: string[] = [];
      for (const b of builtins) {
        if (await platformRepo.findByKey(b.key, t)) {
          skipped.push(b.key);
          continue;
        }
        const skillId = newId('skill');
        const versionId = newId('skillVersion');
        await platformRepo.createSkill(
          {
            id: skillId,
            scope: 'platform',
            brandId: null,
            key: b.key,
            title: b.manifest.title,
            state: 'active',
          },
          t,
        );
        await platformRepo.createVersion(
          {
            id: versionId,
            skillId,
            number: 1,
            manifest: b.manifest,
            instructions: b.instructions,
            references: b.references,
            packageHash: b.packageHash,
            state: 'draft',
            rolloutPercent: 0,
          },
          t,
        );
        await platformRepo.createSuite(
          { id: newId('evaluationSuite'), skillVersionId: versionId, cases: b.cases },
          t,
        );
        seeded.push(b.key);
      }
      return { seeded, skipped };
    }),
  );
}
