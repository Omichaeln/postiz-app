/**
 * Spec 7.6: the API contract is generated in CI and diffed; a breaking diff fails the build unless the contract
 * version is bumped. The contract has two parts: the tRPC procedure catalogue (path, type and the input schema's
 * JSON shape) and the public REST routes under /v1 (method, path, the procedure each serves, its per-key scope and
 * parameters). Removing a procedure or route, changing a procedure's type, a route's procedure or scope, or
 * removing/narrowing an input field is breaking; additions are not. REST inputs are the procedures' inputs, so
 * their field-level changes are caught on the procedure.
 *
 * Usage: `tsx tooling/scripts/check-openapi-diff.ts` (check) or `... --write` (accept the current contract).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { allRestRoutes, appRouter, type RestRoute } from '@oremedia/api';
import { ErrorEnvelopeSchema } from '@oremedia/contracts/errors';
import { zodToJsonSchema } from './zod-json';

interface ProcedureContract {
  type: 'query' | 'mutation' | 'subscription';
  input: unknown;
}
interface RestContract {
  procedure: string;
  type: 'query' | 'mutation';
  scope: string;
  pathParams: string[];
  successStatus: number;
}
interface Contract {
  contractVersion: number;
  procedures: Record<string, ProcedureContract>;
  /** Keyed by `METHOD /v1/path/{param}`. Absent in contracts written before the REST surface. */
  rest?: Record<string, RestContract>;
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
  const rest: Record<string, RestContract> = {};
  for (const r of [...allRestRoutes()].sort((a, b) => restKey(a).localeCompare(restKey(b))))
    rest[restKey(r)] = {
      procedure: r.procedure,
      type: r.type,
      scope: r.scope,
      pathParams: r.pathParams,
      successStatus: r.successStatus ?? 200,
    };
  return { contractVersion, procedures, rest };
}

const openApiPath = (path: string) => path.replace(/:([A-Za-z]+)/g, '{$1}');
function restKey(r: Pick<RestRoute, 'method' | 'path'>): string {
  return `${r.method} ${openApiPath(r.path)}`;
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
  for (const [key, r] of Object.entries(prev.rest ?? {})) {
    const n = next.rest?.[key];
    if (!n) {
      reasons.push(`removed REST route ${key}`);
      continue;
    }
    if (n.procedure !== r.procedure) reasons.push(`REST route ${key} now serves ${n.procedure}`);
    if (n.scope !== r.scope) reasons.push(`REST route ${key} changed scope ${r.scope} → ${n.scope}`);
    if (n.successStatus !== r.successStatus) reasons.push(`REST route ${key} changed its success status`);
  }
  return reasons;
}

/** JSON schema of an object input without the given properties (path parameters travel in the path). */
function withoutProps(schema: unknown, drop: string[]): unknown {
  const s = schema as { properties?: Record<string, unknown>; required?: string[] } | null;
  if (!s?.properties) return schema;
  return {
    ...s,
    properties: Object.fromEntries(Object.entries(s.properties).filter(([k]) => !drop.includes(k))),
    required: (s.required ?? []).filter((k) => !drop.includes(k)),
  };
}

/** The OpenAPI operation of a REST route: parameters, body, scope and the spec 7.2 error envelope. */
function restOperation(route: RestRoute) {
  const input = route.input ? zodToJsonSchema(route.input) : null;
  const props =
    (input as { properties?: Record<string, unknown>; required?: string[] } | null)?.properties ?? {};
  const required = new Set((input as { required?: string[] } | null)?.required ?? []);
  const parameters: unknown[] = route.pathParams.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
  if (route.method === 'GET') {
    for (const [name, schema] of Object.entries(props)) {
      if (route.pathParams.includes(name)) continue;
      if (name === 'page') {
        parameters.push(
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Page size; clamped into [1, 200], default 50 (spec 7.4)',
            schema: { type: 'integer' },
          },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } },
        );
      } else parameters.push({ name, in: 'query', required: required.has(name), schema });
    }
  }
  if (route.type === 'mutation')
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description: 'Spec 7.3: same key and body replays the stored response; a different body is 409',
      schema: { type: 'string', maxLength: 120 },
    });
  const errorResponse = {
    description: 'Error envelope (spec 7.2); the HTTP status follows the code',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
  };
  return {
    operationId: `v1.${route.procedure}`,
    summary: route.summary,
    tags: [route.scope.split(':')[0]],
    security: [{ apiClientKey: [route.scope] }],
    'x-oremedia-scope': route.scope,
    'x-trpc-procedure': route.procedure,
    parameters,
    ...(route.method === 'POST' && input
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: withoutProps(input, route.pathParams) } },
          },
        }
      : {}),
    responses: {
      [String(route.successStatus ?? 200)]: {
        description: 'The procedure result',
        content: { 'application/json': { schema: {} } },
      },
      default: errorResponse,
    },
  };
}

const next = current();
const toOpenApi = (c: Contract) => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [p, proc] of Object.entries(c.procedures))
    paths[`/trpc/${p}`] = {
      [proc.type === 'query' ? 'get' : 'post']: {
        operationId: p,
        'x-trpc-type': proc.type,
        requestBody: proc.input ? { content: { 'application/json': { schema: proc.input } } } : undefined,
      },
    };
  for (const route of allRestRoutes())
    (paths[openApiPath(route.path)] ??= {})[route.method.toLowerCase()] = restOperation(route);
  return {
    openapi: '3.1.0',
    info: {
      title: 'Oremedia API: public REST (/v1) and the tRPC procedure catalogue',
      version: String(c.contractVersion),
    },
    components: {
      securitySchemes: {
        apiClientKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'API client key (ak_...) of a service principal; per-key scopes are enforced (a key with no scopes may only read). Session bearer tokens are accepted with the policy of the user.',
        },
      },
      schemas: { ErrorEnvelope: zodToJsonSchema(ErrorEnvelopeSchema) },
    },
    paths,
    'x-contract': c,
  };
};

if (process.argv.includes('--write') || !existsSync(file)) {
  writeFileSync(file, JSON.stringify(toOpenApi(next), null, 2) + '\n');
  console.error(
    `wrote ${path.relative(process.cwd(), file)} (${Object.keys(next.procedures).length} procedures, ${Object.keys(next.rest ?? {}).length} REST routes)`,
  );
  process.exit(0);
}
const prev = (JSON.parse(readFileSync(file, 'utf8')) as { 'x-contract': Contract })['x-contract'];
const reasons = isBreaking(prev, next);
const additive =
  JSON.stringify(prev.procedures) !== JSON.stringify(next.procedures) ||
  JSON.stringify(prev.rest ?? {}) !== JSON.stringify(next.rest ?? {});
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
