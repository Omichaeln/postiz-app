import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { SkillFile, SkillManifestV1 } from '@oremedia/contracts/skills';
import { INSTRUCTIONS_PATH, MANIFEST_PATH, manifestJson } from './package-format';

/**
 * Test support: tooling/test-fixtures/skill-packages/*.json (spec 18, skill package → runtime), read as data (the
 * fixtures package is not a dependency of this module), expanded into the file list an importer receives.
 */
const FixtureFile = z.union([
  z.object({ path: z.string(), content: z.string() }),
  z.object({ path: z.string(), contentBase64: z.string() }),
  z.object({ path: z.string(), repeat: z.object({ text: z.string().min(1), bytes: z.number().int() }) }),
]);
const MaliciousPackageFixture = z.object({
  id: z.string(),
  attack: z.string(),
  files: z.array(FixtureFile),
  manifestPatch: z.record(z.unknown()).optional(),
  expected: z.array(z.object({ path: z.string(), issue: z.string() })).min(1),
});

export interface MaliciousPackage {
  id: string;
  attack: string;
  files: SkillFile[];
  expected: Array<{ path: string; issue: string }>;
}

const fixturesDir = fileURLToPath(
  new URL('../../../../tooling/test-fixtures/skill-packages/', import.meta.url),
);
const lossyUtf8 = new TextDecoder('utf-8', { fatal: false });

const expand = (f: z.infer<typeof FixtureFile>): SkillFile => {
  if ('content' in f) return f;
  if ('contentBase64' in f)
    return { path: f.path, content: lossyUtf8.decode(Buffer.from(f.contentBase64, 'base64')) };
  return { path: f.path, content: f.repeat.text.repeat(Math.ceil(f.repeat.bytes / f.repeat.text.length)) };
};

export function loadMaliciousPackages(manifest: SkillManifestV1): MaliciousPackage[] {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((name) => {
      const fx = MaliciousPackageFixture.parse(JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')));
      const files = fx.files.map(expand);
      const base: SkillFile[] = [
        {
          path: MANIFEST_PATH,
          content: fx.manifestPatch
            ? JSON.stringify({ ...manifest, ...fx.manifestPatch }, null, 2)
            : manifestJson(manifest),
        },
      ];
      if (!files.some((f) => f.path === INSTRUCTIONS_PATH))
        base.unshift({ path: INSTRUCTIONS_PATH, content: '# Fixture skill\n\nWrite on-brand copy.\n' });
      return { id: fx.id, attack: fx.attack, files: [...base, ...files], expected: fx.expected };
    });
}
