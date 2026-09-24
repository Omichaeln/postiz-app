/**
 * Tool inputs are recorded redacted (spec 12.4 audit, 12.7 "inputs (redacted)"): credential-like keys are masked,
 * long strings truncated, so the run history is inspectable without ever holding a secret or a whole document.
 */
const SENSITIVE_KEY =
  /(token|secret|password|passphrase|credential|api[_-]?key|authorization|cookie|private[_-]?key)/i;
const MAX_STRING = 2000;
const MAX_ITEMS = 200;
const MAX_DEPTH = 8;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (typeof value === 'string')
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING}]`
      : value;
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => redactValue(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `[+${value.length - MAX_ITEMS} more]`] : items;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(v, depth + 1);
    return out;
  }
  return value;
}

/** Always an object (tool_invocations.input_redacted is a JSON object column). */
export function redactForRecord(input: unknown): Record<string, unknown> {
  const redacted = redactValue(input, 0);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : { value: redacted };
}
