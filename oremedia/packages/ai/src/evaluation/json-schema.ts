/**
 * Spec 10.1: skill outputs are validated against the manifest's JSON Schema. This is the subset skills use
 * (object/array/string/number/integer/boolean/null, enum, const, required, properties, additionalProperties,
 * items, minItems/maxItems, minLength/maxLength, minimum/maximum, anyOf/oneOf, $ref to #/definitions or #/$defs).
 * Unknown keywords are ignored, never treated as satisfied checks of their own.
 */
export interface SchemaIssue {
  path: string;
  issue: string;
}

type Schema = Record<string, unknown>;

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

function matchesType(expected: string, v: unknown): boolean {
  const actual = typeOf(v);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return expected === actual;
}

function resolveRef(ref: string, root: Schema): Schema | null {
  const m = /^#\/(definitions|\$defs)\/([^/]+)$/.exec(ref);
  if (!m) return null;
  const defs = root[m[1] as string];
  const def =
    defs && typeof defs === 'object' ? (defs as Record<string, unknown>)[m[2] as string] : undefined;
  return def && typeof def === 'object' ? (def as Schema) : null;
}

function check(
  schema: Schema,
  value: unknown,
  path: string,
  root: Schema,
  issues: SchemaIssue[],
  depth: number,
): void {
  if (depth > 32) return;
  if (typeof schema['$ref'] === 'string') {
    const target = resolveRef(schema['$ref'], root);
    if (!target) issues.push({ path, issue: `unresolvable $ref ${schema['$ref']}` });
    else check(target, value, path, root, issues, depth + 1);
    return;
  }
  const type = schema['type'];
  if (typeof type === 'string' && !matchesType(type, value)) {
    issues.push({ path, issue: `expected ${type}, got ${typeOf(value)}` });
    return;
  }
  if (Array.isArray(type) && !type.some((t) => typeof t === 'string' && matchesType(t, value))) {
    issues.push({ path, issue: `expected one of ${type.join('|')}, got ${typeOf(value)}` });
    return;
  }
  if (
    Array.isArray(schema['enum']) &&
    !schema['enum'].some((e) => JSON.stringify(e) === JSON.stringify(value))
  )
    issues.push({ path, issue: 'not in enum' });
  if ('const' in schema && JSON.stringify(schema['const']) !== JSON.stringify(value))
    issues.push({ path, issue: 'not the const value' });
  for (const key of ['anyOf', 'oneOf'] as const) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives)) {
      const matching = alternatives.filter((alt) => {
        const sub: SchemaIssue[] = [];
        check(alt as Schema, value, path, root, sub, depth + 1);
        return sub.length === 0;
      }).length;
      if (matching === 0 || (key === 'oneOf' && matching !== 1))
        issues.push({ path, issue: `no ${key} alternative matches` });
    }
  }
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength'])
      issues.push({ path, issue: `shorter than ${schema['minLength']}` });
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength'])
      issues.push({ path, issue: `longer than ${schema['maxLength']}` });
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum'])
      issues.push({ path, issue: `below ${schema['minimum']}` });
    if (typeof schema['maximum'] === 'number' && value > schema['maximum'])
      issues.push({ path, issue: `above ${schema['maximum']}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems'])
      issues.push({ path, issue: `fewer than ${schema['minItems']} items` });
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems'])
      issues.push({ path, issue: `more than ${schema['maxItems']} items` });
    const items = schema['items'];
    if (items && typeof items === 'object' && !Array.isArray(items))
      value.forEach((v, i) => check(items as Schema, v, `${path}[${i}]`, root, issues, depth + 1));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema['properties'] ?? {}) as Record<string, Schema>;
    for (const req of Array.isArray(schema['required']) ? schema['required'] : [])
      if (typeof req === 'string' && !(req in obj))
        issues.push({ path: path ? `${path}.${req}` : req, issue: 'required' });
    for (const [k, sub] of Object.entries(props))
      if (k in obj) check(sub, obj[k], path ? `${path}.${k}` : k, root, issues, depth + 1);
    if (schema['additionalProperties'] === false)
      for (const k of Object.keys(obj))
        if (!(k in props)) issues.push({ path: path ? `${path}.${k}` : k, issue: 'additional property' });
  }
}

export function validateJsonSchema(schema: Record<string, unknown>, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  check(schema, value, '', schema, issues, 0);
  return issues;
}
