/**
 * Spec 17.3: logs use a field allowlist; unknown fields are dropped, not redacted by regex.
 * Anything not listed here never reaches a log line, whatever a caller passes.
 */
export const LOG_FIELD_ALLOWLIST: ReadonlySet<string> = new Set([
  // correlation (spec 17.3)
  'correlationId',
  'runId',
  'documentId',
  'revisionId',
  'packageId',
  'publicationId',
  'attemptId',
  'workflowId',
  'eventId',
  // identity references (ids only, never emails or names)
  'tenantId',
  'brandId',
  'actorKind',
  'actorId',
  'principalId',
  'supportSessionId',
  'channelConnectionId',
  'providerKey',
  // operational
  'action',
  'resourceType',
  'resourceId',
  'decision',
  'reason',
  'path',
  'method',
  'status',
  'statusCode',
  'durationMs',
  'attempt',
  'attempts',
  'outcome',
  'state',
  'fromState',
  'toState',
  'errorCode',
  'errorName',
  'errorMessage',
  'queue',
  'taskQueue',
  'phase',
  'ageMs',
  'count',
  'bytes',
  'costMicros',
  'tokensIn',
  'tokensOut',
  'formatKey',
  'metricKey',
  'skillKey',
  'toolName',
  'flag',
  'scope',
  'job',
  'component',
  'version',
  'msg',
  'level',
  'time',
  'pid',
  'hostname',
  'service',
  'env',
]);

/** Keys that are never logged even if a caller tries to smuggle them under an allowed name. */
export const FORBIDDEN_SUBSTRINGS = [
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'credential',
  'ciphertext',
  'prompt',
] as const;

export function filterFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const lower = k.toLowerCase();
    if (FORBIDDEN_SUBSTRINGS.some((s) => lower.includes(s))) continue;
    if (!LOG_FIELD_ALLOWLIST.has(k)) continue;
    out[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v;
  }
  return out;
}
