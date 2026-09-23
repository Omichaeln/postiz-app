/**
 * Secrets scan for the Oremedia tree: fails on patterns that look like committed credentials.
 * Complements gitleaks in CI (see .github/workflows/oremedia-ci.yml); this runs without network.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.git', 'migrations']);
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'check-secrets.ts']);
const PATTERNS: Array<[string, RegExp]> = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['Private key block', /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Slack token', /xox[baprs]-[0-9A-Za-z-]{10,}/],
  [
    'Generic secret assignment',
    /(secret|password|token|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9+/=_-]{24,}['"]/i,
  ],
  ['Database URL with password', /mysql:\/\/[^:\s]+:[^@\s]{6,}@(?!127\.0\.0\.1|localhost)/],
];

let findings = 0;
function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (st.size < 2_000_000 && !SKIP_FILES.has(entry)) {
      const text = readFileSync(full, 'utf8');
      for (const [label, re] of PATTERNS) {
        const m = re.exec(text);
        if (m) {
          const line = text.slice(0, m.index).split('\n').length;
          console.error(`✖ ${label}: ${path.relative(ROOT, full)}:${line}`);
          findings++;
        }
      }
    }
  }
}
walk(ROOT);
console.error(findings ? `${findings} finding(s)` : 'no secrets found');
process.exit(findings ? 1 : 0);
