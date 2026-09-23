/**
 * Spec 7.6: the API contract is generated in CI and diffed; a breaking diff fails the build unless the contract
 * version is bumped. Until the public REST surface exists (Phase 5, trpc-to-openapi over the same commands), the
 * contract is the tRPC procedure catalogue: path, type and the input schema's JSON shape. Removing a procedure,
 * changing its type or removing/narrowing an input field is breaking; additions are not.
 *
 * Usage: `tsx tooling/scripts/check-openapi-diff.ts` (check) or `... --write` (accept the current contract).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { appRouter } from '@oremedia/api';
import { zodToJsonSchema } from './zod-json';

interface ProcedureContract {
  type: 'query' | 'mutation' | 'subscription';
  input: unknown;
}
interface Contract {
  contractVersion: number;
  procedures: Record<string, ProcedureContract>;
}

const file = path.resolve(process.cwd(), 'docs/contracts/openapi.json');
const versionFile = path.resolve(process.cwd(), 'docs/contracts/version.json');

function current(): Contract {
  const procs = appRouter._def.procedures as unknown as Record<
    string,
    { _def: { type: ProcedureContract['type']; inputs?: unknown[] } }
  >;
  const procedures: Record<string, ProcedureContract> = {};
  for (const [p, def] of Object.entries(procs).sort(([a], [b]) => a.localeCompare(b))) {
    const input = def._def.inputs?.[0];
    procedures[p] = { type: def._def.type, input: input ? zodToJsonSchema(input) : null };
  }
  const contractVersion = existsSync(versionFile)
    ? (JSON.parse(readFileSync(versionFile, 'utf8')) as { contractVersion: number }).contractVersion
    : 1;
  return { contractVersion, procedures };
}

function isBreaking(prev: Contract, next: Contract): string[] {
  const reasons: string[] = [];
  for (const [p, c] of Object.entries(prev.procedures)) {
    const n = next.procedures[p];
    if (!n) {
      reasons.push(`removed procedure ${p}`);
      continue;
    }
    if (n.type !== c.type) reasons.push(`procedure ${p} changed type ${c.type} → ${n.type}`);
    const prevProps =
      (c.input as { properties?: Record<string, unknown>; required?: string[] } | null)?.properties ?? {};
    const nextProps =
      (n.input as { properties?: Record<string, unknown>; required?: string[] } | null)?.properties ?? {};
    const nextRequired = new Set((n.input as { required?: string[] } | null)?.required ?? []);
    const prevRequired = new Set((c.input as { required?: string[] } | null)?.required ?? []);
    for (const k of Object.keys(prevProps))
      if (!(k in nextProps)) reasons.push(`procedure ${p} removed input field ${k}`);
    for (const k of nextRequired)
      if (!prevRequired.has(k) && !(k in prevProps))
        reasons.push(`procedure ${p} added required input field ${k}`);
  }
  return reasons;
}

const next = current();
const toOpenApi = (c: Contract) => ({
  openapi: '3.1.0',
  info: { title: 'Oremedia application API (tRPC procedure catalogue)', version: String(c.contractVersion) },
  paths: Object.fromEntries(
    Object.entries(c.procedures).map(([p, proc]) => [
      `/trpc/${p}`,
      {
        [proc.type === 'query' ? 'get' : 'post']: {
          operationId: p,
          'x-trpc-type': proc.type,
          requestBody: proc.input ? { content: { 'application/json': { schema: proc.input } } } : undefined,
        },
      },
    ]),
  ),
  'x-contract': c,
});

if (process.argv.includes('--write') || !existsSync(file)) {
  writeFileSync(file, JSON.stringify(toOpenApi(next), null, 2) + '\n');
  console.error(
    `wrote ${path.relative(process.cwd(), file)} (${Object.keys(next.procedures).length} procedures)`,
  );
  process.exit(0);
}
const prev = (JSON.parse(readFileSync(file, 'utf8')) as { 'x-contract': Contract })['x-contract'];
const reasons = isBreaking(prev, next);
const additive = JSON.stringify(prev.procedures) !== JSON.stringify(next.procedures);
if (reasons.length && next.contractVersion <= prev.contractVersion) {
  console.error('✖ breaking contract change without a version bump (docs/contracts/version.json):');
  for (const r of reasons) console.error(`  - ${r}`);
  process.exit(1);
}
if (additive || reasons.length) {
  console.error(
    `contract changed (${reasons.length ? 'breaking, version bumped' : 'additive'}); run with --write to accept and commit docs/contracts/openapi.json`,
  );
  process.exit(process.env['CI'] ? 1 : 0);
}
console.error('contract unchanged');
