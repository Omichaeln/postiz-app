import { isTRPCClientError } from '@trpc/client';
import {
  ErrorEnvelopeSchema,
  type ErrorCode,
  type ErrorDetail,
  type ErrorEnvelope,
} from '@oremedia/contracts/errors';

/** What the UI does with an error; decided from the envelope `code`, never from `message` (spec 7.2). */
export type UiErrorKind =
  | 'sign_in'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'stale_revision'
  | 'validation'
  | 'conflict'
  | 'rights'
  | 'network'
  | 'other';

export interface UiError {
  kind: UiErrorKind;
  code: ErrorCode | 'NETWORK' | 'UNKNOWN';
  message: string;
  correlationId: string | null;
  details: ErrorDetail[];
  retryAfterMs: number | null;
}

const KIND: Record<ErrorCode, UiErrorKind> = {
  UNAUTHENTICATED: 'sign_in',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION_FAILED: 'validation',
  CONFLICT: 'conflict',
  STALE_REVISION: 'stale_revision',
  IDEMPOTENCY_KEY_REUSED: 'conflict',
  RATE_LIMITED: 'rate_limited',
  ENTITLEMENT_EXCEEDED: 'forbidden',
  BUDGET_EXHAUSTED: 'forbidden',
  APPROVAL_REQUIRED: 'conflict',
  APPROVAL_INVALID: 'conflict',
  RIGHTS_INELIGIBLE: 'rights',
  CAPABILITY_UNSUPPORTED: 'validation',
  PROVIDER_UNAVAILABLE: 'other',
  OUTCOME_UNKNOWN: 'other',
  TENANT_CONTEXT_MISSING: 'other',
  INTERNAL: 'other',
};

/** The error envelope the API formatter puts under `data.envelope` (apps/api/src/trpc.ts). */
export function envelopeOf(err: unknown): ErrorEnvelope | null {
  if (!isTRPCClientError(err)) return null;
  const data = err.data as { envelope?: unknown } | undefined;
  const parsed = ErrorEnvelopeSchema.safeParse(data?.envelope);
  return parsed.success ? parsed.data : null;
}

export function toUiError(err: unknown): UiError {
  const env = envelopeOf(err);
  if (env)
    return {
      kind: KIND[env.code],
      code: env.code,
      message: env.message,
      correlationId: env.correlationId,
      details: env.details ?? [],
      retryAfterMs: env.retryAfterMs ?? null,
    };
  if (isTRPCClientError(err) && !err.data)
    return {
      kind: 'network',
      code: 'NETWORK',
      message: 'The server could not be reached. Check your connection and try again.',
      correlationId: null,
      details: [],
      retryAfterMs: null,
    };
  return {
    kind: 'other',
    code: 'UNKNOWN',
    message: err instanceof Error && err.message ? err.message : 'Something went wrong',
    correlationId: null,
    details: [],
    retryAfterMs: null,
  };
}

/** Where to send someone who is not signed in, keeping the page they wanted. */
export function signInHref(next?: string): string {
  const target = next ?? `${window.location.pathname}${window.location.search}`;
  return `/sign-in?next=${encodeURIComponent(target)}`;
}

export const retryAfterText = (ms: number | null): string =>
  ms === null ? '' : ` Try again in ${Math.max(1, Math.ceil(ms / 1000))} s.`;
