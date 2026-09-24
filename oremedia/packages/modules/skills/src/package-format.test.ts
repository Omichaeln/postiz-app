import { describe, expect, it } from 'vitest';
import { ValidationFailedError } from '@oremedia/contracts/errors';
import type { SkillManifestV1 } from '@oremedia/contracts/skills';
import { hashCanonical } from '@oremedia/domain/hash';
import {
  assertDeclarative,
  buildContent,
  manifestJson,
  packageHash,
  parsePackage,
  splitFrontMatter,
  toPackage,
} from './package-format';
import { loadMaliciousPackages } from './package-fixtures';

const manifest = (over: Partial<SkillManifestV1> = {}): SkillManifestV1 => ({
  schemaVersion: 1,
  key: 'unit-skill',
  title: 'Unit skill',
  description: 'unit',
  taskKinds: ['copywriting'],
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  requiredContext: ['brand_snapshot'],
  allowedTools: ['brand.getSnapshot'],
  budgets: { maxSteps: 5, maxTokens: 1000, maxCostMicros: 1000, maxVariants: 1, deadlineSeconds: 60 },
  modelCompatibility: ['anthropic:*'],
  instructionsPath: 'SKILL.md',
  ...over,
});

const details = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationFailedError);
    return (err as ValidationFailedError).details ?? [];
  }
  throw new Error('expected ValidationFailedError');
};

describe('Agent Skills package format (spec 10.1)', () => {
  it('parses SKILL.md + manifest.json + references and round-trips byte-identically', () => {
    const files = [
      { path: 'references/checklist.md', content: '# Checklist\n' },
      { path: 'SKILL.md', content: '# Unit skill\n\nDo the thing.\n' },
      { path: 'assets/example.json', content: '{"a":1}\n' },
      { path: 'manifest.json', content: manifestJson(manifest()) },
    ];
    const content = parsePackage(files);
    expect(content.manifest).toEqual(manifest());
    expect(content.instructions).toBe('# Unit skill\n\nDo the thing.\n');
    expect(content.references).toEqual({
      'references/checklist.md': '# Checklist\n',
      'assets/example.json': '{"a":1}\n',
    });
    const exported = toPackage(content);
    expect(exported.map((f) => f.path)).toEqual([
      'SKILL.md',
      'manifest.json',
      'assets/example.json',
      'references/checklist.md',
    ]);
    expect(Object.fromEntries(exported.map((f) => [f.path, f.content]))).toEqual(
      Object.fromEntries(files.map((f) => [f.path, f.content])),
    );
    expect(packageHash(content)).toBe(hashCanonical({ files: exported }));
  });

  it('parses the manifest from YAML front matter (scalars, block lists, nested maps, inline JSON)', () => {
    const skillMd = [
      '---',
      'schemaVersion: 1',
      'key: unit-skill',
      'title: "Unit skill"',
      'description: unit',
      '# a comment',
      'taskKinds: [copywriting]',
      'inputSchema: {"type":"object"}',
      'outputSchema: {"type": "object"}',
      'requiredContext:',
      '  - brand_snapshot',
      'allowedTools:',
      '  - brand.getSnapshot',
      'budgets:',
      '  maxSteps: 5',
      '  maxTokens: 1000',
      '  maxCostMicros: 1000',
      '  maxVariants: 1',
      '  deadlineSeconds: 60',
      "modelCompatibility: ['anthropic:*']",
      'instructionsPath: SKILL.md',
      '---',
      '# Unit skill',
      '',
      'Body.',
      '',
    ].join('\n');
    const split = splitFrontMatter(skillMd);
    expect(split.body).toBe('# Unit skill\n\nBody.\n');
    expect(split.data).toEqual(manifest());
    const content = parsePackage([{ path: 'SKILL.md', content: skillMd }]);
    expect(content.manifest).toEqual(manifest());
    expect(content.instructions).toBe('# Unit skill\n\nBody.\n');
    expect(splitFrontMatter('# No front matter\n')).toEqual({ data: null, body: '# No front matter\n' });
  });

  it('manifest.json wins over front matter; a package without either is refused', () => {
    const fm = '---\nkey: other\n---\n# Body\n';
    const content = parsePackage([
      { path: 'SKILL.md', content: fm },
      { path: 'manifest.json', content: manifestJson(manifest()) },
    ]);
    expect(content.manifest.key).toBe('unit-skill');
    expect(content.instructions).toBe('# Body\n');
    expect(details(() => parsePackage([{ path: 'SKILL.md', content: '# Body\n' }]))).toEqual([
      { path: 'manifest.json', issue: 'missing' },
    ]);
    expect(details(() => parsePackage([{ path: 'manifest.json', content: '{}' }]))).toEqual([
      { path: 'SKILL.md', issue: 'missing' },
    ]);
    expect(
      details(() =>
        parsePackage([
          { path: 'SKILL.md', content: '# Body\n' },
          { path: 'manifest.json', content: '{not json' },
        ]),
      )[0]?.path,
    ).toBe('manifest.json');
  });

  it('refuses executable content: scripts directory, executable extensions, shebangs and a manifest scripts field', () => {
    const m = manifest();
    const issue = (files: Array<{ path: string; content: string }>, raw: Record<string, unknown> = m) =>
      details(() => assertDeclarative(files, raw));
    expect(issue([{ path: 'scripts/run.md', content: 'x' }])).toEqual([
      { path: 'scripts/run.md', issue: 'executable_content_prohibited' },
    ]);
    expect(issue([{ path: 'references/helper.py', content: 'print(1)' }])).toEqual([
      { path: 'references/helper.py', issue: 'executable_content_prohibited' },
    ]);
    expect(issue([{ path: 'references/tool', content: '#!/bin/sh\necho hi' }])).toEqual([
      { path: 'references/tool', issue: 'executable_content_prohibited' },
    ]);
    expect(issue([{ path: 'references/a.md', content: 'fine' }], { ...m, scripts: { run: 'x' } })).toEqual([
      { path: 'manifest.scripts', issue: 'executable_content_prohibited' },
    ]);
    expect(
      details(() =>
        parsePackage([
          { path: 'SKILL.md', content: '# Body\n' },
          { path: 'manifest.json', content: manifestJson(m) },
          { path: 'scripts/setup.sh', content: 'echo' },
        ]),
      ),
    ).toEqual([{ path: 'scripts/setup.sh', issue: 'executable_content_prohibited' }]);
    expect(() => assertDeclarative([{ path: 'references/a.md', content: 'fine' }], m)).not.toThrow();
  });

  it('refuses tools outside the Release 1 registry, empty instructions and bad paths', () => {
    expect(
      details(() => buildContent(manifest({ allowedTools: ['brand.getSnapshot', 'shell.exec'] }), '# x', [])),
    ).toEqual([{ path: 'manifest.allowedTools', issue: 'unknown_tool:shell.exec' }]);
    expect(details(() => buildContent(manifest(), '   \n', []))).toEqual([
      { path: 'SKILL.md', issue: 'instructions_empty' },
    ]);
    expect(details(() => buildContent(manifest(), '# x', [{ path: '../escape.md', content: 'x' }]))).toEqual([
      { path: '../escape.md', issue: 'invalid_path' },
    ]);
    expect(details(() => buildContent(manifest(), '# x', [{ path: '/abs.md', content: 'x' }]))).toEqual([
      { path: '/abs.md', issue: 'invalid_path' },
    ]);
    expect(
      details(() => buildContent(manifest(), '# x', [{ path: 'manifest.json', content: '{}' }])),
    ).toEqual([{ path: 'manifest.json', issue: 'reserved_path' }]);
    expect(() =>
      buildContent(manifest({ budgets: { ...manifest().budgets, maxSteps: 99 } }), '# x', []),
    ).toThrow();
  });
});

describe('malicious package fixtures (spec 18: skill package → runtime)', () => {
  const packages = loadMaliciousPackages(manifest());
  const sorted = (d: ReadonlyArray<{ path?: string; issue: string }>) =>
    [...d].sort((a, b) => `${a.path}|${a.issue}`.localeCompare(`${b.path}|${b.issue}`));

  it('covers every attack class the threat model names', () => {
    expect(new Set(packages.map((p) => p.attack))).toEqual(
      new Set([
        'path_traversal',
        'absolute_path',
        'symlink',
        'executable',
        'remote_fetch',
        'link',
        'duplicate',
        'encoding',
        'oversized',
      ]),
    );
  });

  it.each(packages.map((p) => [p.id, p] as const))('%s is refused with its typed reasons', (_id, pkg) => {
    expect(sorted(details(() => parsePackage(pkg.files)))).toEqual(sorted(pkg.expected));
  });

  it('a benign package with citations and in-package links still parses', () => {
    const content = parsePackage([
      {
        path: 'SKILL.md',
        content:
          '# Unit skill\n\nFollow [the checklist](references/checklist.md#steps), cite [the guide](https://example.com/guide) and ![the grid](assets/grid.svg). Contact <mailto:brand@example.com>.\n',
      },
      { path: 'manifest.json', content: manifestJson(manifest()) },
      { path: 'references/checklist.md', content: '# Steps\n\nSee [back](../SKILL.md).\n' },
      { path: 'assets/grid.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    ]);
    expect(Object.keys(content.references)).toEqual(['references/checklist.md', 'assets/grid.svg']);
  });
});
