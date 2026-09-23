import { z } from 'zod';

/** Spec 7.2: the single error vocabulary. Clients branch on `code`, never on `message`. */
export const ErrorCode = z.enum([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'STALE_REVISION',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMITED',
  'ENTITLEMENT_EXCEEDED',
  'BUDGET_EXHAUSTED',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'RIGHTS_INELIGIBLE',
  'CAPABILITY_UNSUPPORTED',
  'PROVIDER_UNAVAILABLE',
  'OUTCOME_UNKNOWN',
  'TENANT_CONTEXT_MISSING',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export interface ErrorDetail {
  path?: string;
  issue: string;
}

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string; // human-readable, safe to show
  correlationId: string;
  details?: ErrorDetail[]; // validation detail, never internal state
  retryAfterMs?: number;
}

export const ErrorEnvelopeSchema = z.object({
  code: ErrorCode,
  message: z.string(),
  correlationId: z.string(),
  details: z.array(z.object({ path: z.string().optional(), issue: z.string() })).optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
});

const HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  STALE_REVISION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RATE_LIMITED: 429,
  ENTITLEMENT_EXCEEDED: 402,
  BUDGET_EXHAUSTED: 402,
  APPROVAL_REQUIRED: 409,
  APPROVAL_INVALID: 409,
  RIGHTS_INELIGIBLE: 409,
  CAPABILITY_UNSUPPORTED: 422,
  PROVIDER_UNAVAILABLE: 503,
  OUTCOME_UNKNOWN: 409,
  TENANT_CONTEXT_MISSING: 500,
  INTERNAL: 500,
};

export const httpStatusFor = (code: ErrorCode): number => HTTP_STATUS[code];

/** Base class for every domain error. Messages are user-safe by construction; internal detail goes to logs. */
export class OremediaError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetail[] | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { details?: ErrorDetail[]; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.details = opts?.details;
    this.retryAfterMs = opts?.retryAfterMs;
  }

  get httpStatus(): number {
    return httpStatusFor(this.code);
  }
}

export class UnauthenticatedError extends OremediaError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message);
  }
}

/** Foreign-tenant IDs produce NOT_FOUND, never FORBIDDEN, so existence is not leaked (spec 5.3). */
export class NotFoundError extends OremediaError {
  readonly resourceType: string;
  readonly resourceId: string;
  constructor(resourceType: string, resourceId: string) {
    super('NOT_FOUND', `${resourceType} not found`);
    this.resourceType = resourceType;
    this.resourceId = resourceId;
  }
}

export class PolicyDeniedError extends OremediaError {
  readonly reason: string;
  constructor(reason: string, message = 'You are not allowed to perform this action') {
    super('FORBIDDEN', message);
    this.reason = reason;
  }
}

export class ValidationFailedError extends OremediaError {
  constructor(details: ErrorDetail[], message = 'Validation failed') {
    super('VALIDATION_FAILED', message, { details });
  }
}

export class ConflictError extends OremediaError {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: number;
  constructor(resourceType: string, resourceId: string, expectedVersion: number) {
    super('CONFLICT', `${resourceType} was modified concurrently`);
    this.resourceType = resourceType;
    this.resourceId = resourceId;
    this.expectedVersion = expectedVersion;
  }
}

export class StaleRevisionError extends OremediaError {
  readonly currentRevisionId: string;
  constructor(currentRevisionId: string) {
    super('STALE_REVISION', 'The document changed since your last revision; rebase or branch');
    this.currentRevisionId = currentRevisionId;
  }
}

export class IdempotencyKeyReusedError extends OremediaError {
  constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used with a different request');
  }
}

export class IdempotencyInProgressError extends OremediaError {
  constructor(retryAfterMs: number) {
    super('CONFLICT', 'A request with this idempotency key is in progress', { retryAfterMs });
  }
}

export class RateLimitedError extends OremediaError {
  constructor(retryAfterMs: number) {
    super('RATE_LIMITED', 'Too many requests', { retryAfterMs });
  }
}

export class EntitlementExceededError extends OremediaError {
  readonly feature: string;
  constructor(feature: string, reason: string) {
    super('ENTITLEMENT_EXCEEDED', `Your plan does not allow this: ${reason}`);
    this.feature = feature;
  }
}

export class BudgetExhaustedError extends OremediaError {
  readonly scope: string;
  constructor(scope: string) {
    super('BUDGET_EXHAUSTED', `Budget exhausted (${scope})`);
    this.scope = scope;
  }
}

export class ApprovalRequiredError extends OremediaError {
  constructor(message = 'A valid approval is required') {
    super('APPROVAL_REQUIRED', message);
  }
}

export class ApprovalInvalidError extends OremediaError {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super('APPROVAL_INVALID', 'The approval no longer matches the content or its conditions', {
      details: reasons.map((r) => ({ issue: r })),
    });
    this.reasons = reasons;
  }
}

export class RightsIneligibleError extends OremediaError {
  constructor(assetVersionId: string, reason: string) {
    super('RIGHTS_INELIGIBLE', 'An asset is not eligible for this use', {
      details: [{ path: assetVersionId, issue: reason }],
    });
  }
}

export class CapabilityUnsupportedError extends OremediaError {
  constructor(details: ErrorDetail[]) {
    super('CAPABILITY_UNSUPPORTED', 'The channel does not support this content', { details });
  }
}

export class ProviderUnavailableError extends OremediaError {
  constructor(providerKey: string, retryAfterMs?: number) {
    super(
      'PROVIDER_UNAVAILABLE',
      `${providerKey} is unavailable`,
      retryAfterMs === undefined ? undefined : { retryAfterMs },
    );
  }
}

export class OutcomeUnknownError extends OremediaError {
  constructor(publicationId: string) {
    super('OUTCOME_UNKNOWN', 'The platform may have accepted this action; it will be reconciled', {
      details: [{ path: publicationId, issue: 'outcome_unknown' }],
    });
  }
}

/** Loud by design: a missing tenant context is a bug, never a fallback to "all rows" (spec 5.2). */
export class TenantContextMissingError extends OremediaError {
  constructor() {
    super('TENANT_CONTEXT_MISSING', 'Tenant context is missing');
  }
}

export class InternalError extends OremediaError {
  constructor(cause?: unknown) {
    super('INTERNAL', 'Something went wrong', { cause });
  }
}

export const isOremediaError = (e: unknown): e is OremediaError => e instanceof OremediaError;

/** Converts any thrown value to the public envelope. Unknown errors become INTERNAL with no internal detail. */
export function toErrorEnvelope(error: unknown, correlationId: string): ErrorEnvelope {
  if (isOremediaError(error)) {
    const env: ErrorEnvelope = { code: error.code, message: error.message, correlationId };
    if (error.details) env.details = error.details;
    if (error.retryAfterMs !== undefined) env.retryAfterMs = error.retryAfterMs;
    return env;
  }
  return { code: 'INTERNAL', message: 'Something went wrong', correlationId };
}
