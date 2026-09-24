import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Runbook "roll back a workflow version safely" (spec 14.3, 17.7, ledger 7.13), as executable checks:
 *  1. a deployed workflow file is immutable: every *.workflow.v<N>.ts that git knows is byte-identical to the
 *     version its first commit added, and no later commit changed it (a change ships as v<N+1>);
 *  2. rolling back means routing new starts to the previous version while the new one drains, so every queue entry
 *     that serves a workflow family exports every version of it present in the tree, and every workflow function
 *     is served by some queue.
 * Lives outside src/ because workflow sources may not import Node built-ins (eslint no-restricted-imports).
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const VERSIONED = /^(.+)\.workflow\.v(\d+)\.ts$/;

const git = (args: string[]): string | null => {
  try {
    return execFileSync('git', args, { cwd: src, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};
const repoRoot = git(['rev-parse', '--show-toplevel'])?.trim() ?? null;

const versionFiles = readdirSync(src)
  .filter((f) => VERSIONED.test(f))
  .map((f) => {
    const [, family, version] = VERSIONED.exec(f)!;
    return { file: f, family: family!, version: Number(version) };
  });

/** Exported workflow functions of a module: functions whose name ends in V<N> (workflows and signal relays). */
async function workflowExports(path: string): Promise<string[]> {
  const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  return Object.entries(mod)
    .filter(([name, v]) => typeof v === 'function' && /V\d+$/.test(name))
    .map(([name]) => name)
    .sort();
}

describe('rollback-workflow-version runbook: deployed workflow versions are immutable and all served', () => {
  it('there are versioned workflow files to check', () => {
    expect(versionFiles.length).toBeGreaterThan(0);
  });

  it.skipIf(!repoRoot).each(versionFiles.map((v) => v.file))(
    '%s is byte-identical to its first committed version and never changed after',
    (file) => {
      const path = relative(repoRoot!, join(src, file));
      const commits = (git(['log', '--format=%H', '--', path]) ?? '').split('\n').filter(Boolean);
      if (commits.length === 0) return; // not committed yet: frozen from its first commit on
      const first = commits[commits.length - 1]!;
      const committed = execFileSync('git', ['show', `${first}:${path}`], { cwd: repoRoot! });
      expect(Buffer.compare(committed, readFileSync(join(src, file))), `${file} differs from ${first}`).toBe(
        0,
      );
      expect(
        commits,
        `${file} was modified after it was first committed; ship a new version instead`,
      ).toHaveLength(1);
    },
  );

  it('each queue entry exports every version of each workflow family it serves; every workflow is served', async () => {
    const byFamily = new Map<string, Map<number, string[]>>();
    for (const v of versionFiles) {
      const names = await workflowExports(join(src, v.file));
      const versions = byFamily.get(v.family) ?? new Map<number, string[]>();
      versions.set(v.version, names);
      byFamily.set(v.family, versions);
    }
    const queues = readdirSync(join(src, 'queues')).filter((f) => f.endsWith('.ts'));
    const served = new Set<string>();
    for (const q of queues) {
      const exported = new Set(await workflowExports(join(src, 'queues', q)));
      for (const [family, versions] of byFamily) {
        const all = [...versions.values()].flat();
        if (!all.some((n) => exported.has(n))) continue; // this queue does not serve the family
        const missing = all.filter((n) => !exported.has(n));
        expect(missing, `queue ${q} serves ${family} but omits ${missing.join(', ')}`).toEqual([]);
      }
      exported.forEach((n) => served.add(n));
    }
    const unserved = [...byFamily.values()]
      .flatMap((versions) => [...versions.values()].flat())
      .filter((n) => !served.has(n));
    expect(unserved, 'workflows no queue entry registers').toEqual([]);
  });
});
