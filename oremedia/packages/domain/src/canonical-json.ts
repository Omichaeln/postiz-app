/**
 * RFC 8785 (JSON Canonicalization Scheme) subset sufficient for approval bindings and content hashes:
 *  - object keys sorted by UTF-16 code units,
 *  - no whitespace,
 *  - numbers serialised per ES ToString (finite only),
 *  - strings escaped per JSON with lowercase \u00xx for control characters,
 *  - undefined properties omitted; undefined in arrays becomes null.
 * One implementation, tested with fixtures (spec 13.2).
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined };

function escapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i] as string;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined)
    throw new TypeError('canonicalJson: undefined is not serialisable at the top level');
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return Object.is(value, -0) ? '0' : String(value);
    case 'string':
      return escapeString(value);
    case 'bigint':
      throw new TypeError('canonicalJson: bigint is not JSON');
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
      }
      if (value instanceof Date) return escapeString(value.toISOString());
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort((a, b) => {
          // Sort by UTF-16 code units (RFC 8785 §3.2.3).
          const len = Math.min(a.length, b.length);
          for (let i = 0; i < len; i++) {
            const d = a.charCodeAt(i) - b.charCodeAt(i);
            if (d !== 0) return d;
          }
          return a.length - b.length;
        });
      return '{' + keys.map((k) => escapeString(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
