import { ValidationFailedError, type ErrorDetail } from '@oremedia/contracts/errors';
import { SkillManifestV1, TOOL_NAMES_RELEASE_1, type SkillFile } from '@oremedia/contracts/skills';
import { hashCanonical } from '@oremedia/domain/hash';

/** Spec 10.1: the Agent Skills convention. SKILL.md carries the instructions; the manifest sits in its YAML front matter or in a sibling manifest.json. */
export const INSTRUCTIONS_PATH = 'SKILL.md';
export const MANIFEST_PATH = 'manifest.json';

export interface SkillPackageContent {
  manifest: SkillManifestV1;
  instructions: string;
  /** Every other file of the package (references/*, assets/*), keyed by its relative path. */
  references: Record<string, string>;
}

const EXECUTABLE_EXTENSIONS = new Set([
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'py',
  'pyc',
  'sh',
  'bash',
  'zsh',
  'fish',
  'rb',
  'php',
  'pl',
  'ps1',
  'bat',
  'cmd',
  'exe',
  'com',
  'jar',
  'wasm',
  'so',
  'dll',
  'dylib',
  'bin',
  'vbs',
  'scpt',
  'apk',
  'msi',
]);

const fail = (details: ErrorDetail[], message: string): never => {
  throw new ValidationFailedError(details, message);
};

/** Relative, forward-slash paths only; no traversal, no absolute paths, no control characters. */
function assertValidPaths(files: SkillFile[]): void {
  const seen = new Set<string>();
  const details: ErrorDetail[] = [];
  for (const f of files) {
    const segments = f.path.split('/');
    const bad =
      f.path.startsWith('/') ||
      f.path.includes('\\') ||
      [...f.path].some((ch) => ch.charCodeAt(0) < 0x20) ||
      segments.some((s) => s === '' || s === '.' || s === '..');
    if (bad) details.push({ path: f.path, issue: 'invalid_path' });
    if (seen.has(f.path)) details.push({ path: f.path, issue: 'duplicate_path' });
    seen.add(f.path);
  }
  if (details.length) fail(details, 'Package file paths must be unique, relative paths');
}

/**
 * Spec 10.1 Release 1: skills are declarative only. A scripts directory, an executable file type, a shebang or a
 * manifest `scripts` field is refused before anything is parsed or written.
 */
export function assertDeclarative(files: SkillFile[], rawManifest: Record<string, unknown>): void {
  const details: ErrorDetail[] = [];
  if ('scripts' in rawManifest)
    details.push({ path: 'manifest.scripts', issue: 'executable_content_prohibited' });
  for (const f of files) {
    const segments = f.path.split('/');
    const name = segments[segments.length - 1] ?? '';
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (segments.includes('scripts') || EXECUTABLE_EXTENSIONS.has(ext) || f.content.startsWith('#!'))
      details.push({ path: f.path, issue: 'executable_content_prohibited' });
  }
  if (details.length)
    fail(details, 'Skills are declarative only in Release 1: executable content is prohibited');
}

/** allowedTools ⊆ the Release 1 tool registry (spec 10.1, 12.4). */
export function assertAllowedTools(manifest: SkillManifestV1): void {
  const known = new Set<string>(TOOL_NAMES_RELEASE_1);
  const details = manifest.allowedTools
    .filter((t) => !known.has(t))
    .map((t) => ({ path: 'manifest.allowedTools', issue: `unknown_tool:${t}` }));
  if (details.length) fail(details, 'allowedTools must be a subset of the tool registry');
}

// ---- tiny YAML subset for SKILL.md front matter ----
// Supported: block mappings, block sequences ("- item"), scalars (quoted or bare strings, numbers, booleans, null)
// and inline JSON values ({...} / [...]). Not supported: anchors, multi-line scalars, flow mappings beyond JSON.
type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };
interface YamlLine {
  indent: number;
  text: string;
}

function yamlScalar(raw: string, path: string): YamlValue {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s) as YamlValue;
    } catch {
      if (s.startsWith('[') && s.endsWith(']'))
        return s
          .slice(1, -1)
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .map((item) => yamlScalar(item, path));
      return fail(
        [{ path, issue: 'front matter value is not valid JSON' }],
        'SKILL.md front matter is invalid',
      );
    }
  }
  return s;
}

function yamlBlock(lines: YamlLine[], start: number, indent: number, path: string): [YamlValue, number] {
  const first = lines[start];
  if (!first) return [{}, start];
  let i = start;
  if (first.text === '-' || first.text.startsWith('- ')) {
    const list: YamlValue[] = [];
    while (i < lines.length && (lines[i] as YamlLine).indent === indent) {
      const line = lines[i] as YamlLine;
      if (!(line.text === '-' || line.text.startsWith('- '))) break;
      const rest = line.text.slice(1).trim();
      const next = lines[i + 1];
      if (rest === '' && next && next.indent > indent) {
        const [value, after] = yamlBlock(lines, i + 1, next.indent, `${path}[${list.length}]`);
        list.push(value);
        i = after;
      } else {
        list.push(yamlScalar(rest, `${path}[${list.length}]`));
        i++;
      }
    }
    return [list, i];
  }
  const map: { [k: string]: YamlValue } = {};
  while (i < lines.length && (lines[i] as YamlLine).indent === indent) {
    const line = lines[i] as YamlLine;
    if (line.text.startsWith('- ')) break;
    const colon = line.text.indexOf(':');
    if (colon <= 0)
      return fail([{ path, issue: `cannot parse "${line.text}"` }], 'SKILL.md front matter is invalid');
    const key = line.text
      .slice(0, colon)
      .trim()
      .replace(/^["']|["']$/g, '');
    const rest = line.text.slice(colon + 1).trim();
    const next = lines[i + 1];
    if (rest === '' && next && next.indent > indent) {
      const [value, after] = yamlBlock(lines, i + 1, next.indent, `${path}.${key}`);
      map[key] = value;
      i = after;
    } else {
      map[key] = yamlScalar(rest, `${path}.${key}`);
      i++;
    }
  }
  return [map, i];
}

/** Splits `---\n...\n---\n` front matter from a SKILL.md body. `data` is null when there is no front matter. */
export function splitFrontMatter(text: string): { data: Record<string, unknown> | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: null, body: text };
  const lines: YamlLine[] = (m[1] ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  if (lines.length === 0) return { data: {}, body: text.slice(m[0].length) };
  const [value] = yamlBlock(lines, 0, (lines[0] as YamlLine).indent, 'frontMatter');
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return fail(
      [{ path: 'SKILL.md', issue: 'front matter must be a mapping' }],
      'SKILL.md front matter is invalid',
    );
  return { data: value, body: text.slice(m[0].length) };
}

/** Validates the parts of a package (manifest already isolated) and returns the content the registry stores. */
export function buildContent(
  rawManifest: Record<string, unknown>,
  instructions: string,
  references: SkillFile[],
): SkillPackageContent {
  const files: SkillFile[] = [
    { path: INSTRUCTIONS_PATH, content: instructions },
    ...references.map((r) => ({ path: r.path, content: r.content })),
  ];
  assertValidPaths(files);
  const reserved = references.filter((r) => r.path === INSTRUCTIONS_PATH || r.path === MANIFEST_PATH);
  if (reserved.length)
    fail(
      reserved.map((r) => ({ path: r.path, issue: 'reserved_path' })),
      'SKILL.md and manifest.json are not reference files',
    );
  assertDeclarative(files, rawManifest);
  const manifest = SkillManifestV1.parse(rawManifest);
  assertAllowedTools(manifest);
  if (instructions.trim() === '')
    fail([{ path: INSTRUCTIONS_PATH, issue: 'instructions_empty' }], 'SKILL.md must contain instructions');
  return {
    manifest,
    instructions,
    references: Object.fromEntries(references.map((r) => [r.path, r.content])),
  };
}

/** Import: an Agent Skills package (SKILL.md with front matter, or SKILL.md + manifest.json, plus references and assets). */
export function parsePackage(files: SkillFile[]): SkillPackageContent {
  assertValidPaths(files);
  const skillMd = files.find((f) => f.path === INSTRUCTIONS_PATH);
  if (!skillMd)
    return fail([{ path: INSTRUCTIONS_PATH, issue: 'missing' }], 'A skill package needs a SKILL.md');
  const manifestFile = files.find((f) => f.path === MANIFEST_PATH);
  const { data: frontMatter, body } = splitFrontMatter(skillMd.content);
  let rawManifest: Record<string, unknown>;
  if (manifestFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestFile.content);
    } catch {
      return fail([{ path: MANIFEST_PATH, issue: 'not valid JSON' }], 'manifest.json is not valid JSON');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return fail([{ path: MANIFEST_PATH, issue: 'must be an object' }], 'manifest.json must be an object');
    rawManifest = parsed as Record<string, unknown>;
  } else if (frontMatter) {
    rawManifest = frontMatter;
  } else {
    return fail(
      [{ path: MANIFEST_PATH, issue: 'missing' }],
      'A skill package needs a manifest.json or SKILL.md front matter',
    );
  }
  const references = files.filter((f) => f.path !== INSTRUCTIONS_PATH && f.path !== MANIFEST_PATH);
  return buildContent(rawManifest, body, references);
}

/** Canonical manifest.json text: 2-space JSON with a trailing newline, so an exported package is stable. */
export const manifestJson = (manifest: SkillManifestV1): string => JSON.stringify(manifest, null, 2) + '\n';

/** Export: SKILL.md, manifest.json, then every reference in path order. */
export function toPackage(content: SkillPackageContent): SkillFile[] {
  const references = Object.entries(content.references)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, text]) => ({ path, content: text }));
  return [
    { path: INSTRUCTIONS_PATH, content: content.instructions },
    { path: MANIFEST_PATH, content: manifestJson(content.manifest) },
    ...references,
  ];
}

/** The package hash every run pins: hashCanonical of the exported file list. */
export const packageHash = (content: SkillPackageContent): string =>
  hashCanonical({ files: toPackage(content) });

export const referencesToFiles = (references: Record<string, string>): SkillFile[] =>
  Object.entries(references)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => ({ path, content }));
