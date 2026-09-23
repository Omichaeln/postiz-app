import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import { runInTenant } from '@oremedia/db';
import {
  isOremediaError,
  toErrorEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
} from '@oremedia/contracts/errors';
import { resolveTenantContext, type ResolvedTenant } from '@oremedia/module-access';
import {
  MemoryRateLimiterStore,
  RateLimiter,
  RedisRateLimiterStore,
  hashRequest,
} from '@oremedia/module-operations';
import { withLogContext } from '@oremedia/observability';
import type { RequestContext } from './context';

const TRPC_CODE: Record<ErrorCode, TRPC_ERROR_CODE_KEY> = {
  UNAUTHENTICATED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'BAD_REQUEST',
  CONFLICT: 'CONFLICT',
  STALE_REVISION: 'CONFLICT',
  IDEMPOTENCY_KEY_REUSED: 'CONFLICT',
  RATE_LIMITED: 'TOO_MANY_REQUESTS',
  ENTITLEMENT_EXCEEDED: 'PAYMENT_REQUIRED',
  BUDGET_EXHAUSTED: 'PAYMENT_REQUIRED',
  APPROVAL_REQUIRED: 'CONFLICT',
  APPROVAL_INVALID: 'CONFLICT',
  RIGHTS_INELIGIBLE: 'CONFLICT',
  CAPABILITY_UNSUPPORTED: 'UNPROCESSABLE_CONTENT',
  PROVIDER_UNAVAILABLE: 'INTERNAL_SERVER_ERROR',
  OUTCOME_UNKNOWN: 'CONFLICT',
  TENANT_CONTEXT_MISSING: 'INTERNAL_SERVER_ERROR',
  INTERNAL: 'INTERNAL_SERVER_ERROR',
};

/** Spec 7.2: one envelope for every error; validation issues are surfaced as VALIDATION_FAILED with details. */
export function envelopeFor(error: TRPCError, correlationId: string): ErrorEnvelope {
  const cause = error.cause;
  if (isOremediaError(cause)) return toErrorEnvelope(cause, correlationId);
  if (cause instanceof ZodError) {
    return {
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      correlationId,
      details: cause.issues.map((i) => ({ path: i.path.join('.'), issue: i.message })),
    };
  }
  switch (error.code) {
    case 'UNAUTHORIZED':
      return { code: 'UNAUTHENTICATED', message: 'Authentication required', correlationId };
    case 'FORBIDDEN':
      return { code: 'FORBIDDEN', message: 'You are not allowed to perform this action', correlationId };
    case 'NOT_FOUND':
      return { code: 'NOT_FOUND', message: 'Not found', correlationId };
    case 'BAD_REQUEST':
      return {
        code: 'VALIDATION_FAILED',
        message:
          error.message === 'IDEMPOTENCY_KEY_REQUIRED' ? 'Idempotency-Key header is required' : 'Bad request',
        correlationId,
        ...(error.message === 'IDEMPOTENCY_KEY_REQUIRED'
          ? { details: [{ path: 'Idempotency-Key', issue: 'required' }] }
          : {}),
      };
    case 'TOO_MANY_REQUESTS':
      return { code: 'RATE_LIMITED', message: 'Too many requests', correlationId };
    default:
      return { code: 'INTERNAL', message: 'Something went wrong', correlationId };
  }
}

export const t = initTRPC.context<RequestContext>().create({
  transformer: superjson,
  errorFormatter: ({ shape, error, ctx }) => ({
    ...shape,
    message: envelopeFor(error, ctx?.correlationId ?? 'unknown').message,
    data: { ...shape.data, envelope: envelopeFor(error, ctx?.correlationId ?? 'unknown') },
  }),
});

/** Domain errors become TRPC errors with the domain error as cause; the formatter builds the envelope from it. */
const domainErrors = t.middleware(async ({ next, ctx }) => {
  try {
    return await withLogContext({ correlationId: ctx.correlationId }, () => next());
  } catch (err) {
    if (isOremediaError(err))
      throw new TRPCError({ code: TRPC_CODE[err.code], message: err.message, cause: err });
    throw err;
  }
});

const authed = t.middleware(async ({ ctx, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

/** Tenant procedures: tenant is resolved server-side from the session's selected company and verified membership. */
const tenantScoped = t.middleware(async ({ ctx, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const tenant: ResolvedTenant = await resolveTenantContext(
    ctx.principal,
    ctx.requestedTenantId,
    ctx.correlationId,
  );
  return runInTenant(tenant.context, () =>
    withLogContext({ tenantId: tenant.context.tenantId }, () =>
      next({ ctx: { ...ctx, principal: ctx.principal as NonNullable<typeof ctx.principal>, tenant } }),
    ),
  );
});

let limiter: RateLimiter | null = null;
export function configureRateLimiter(redis?: ConstructorParameters<typeof RedisRateLimiterStore>[0]): void {
  limiter = new RateLimiter(redis ? new RedisRateLimiterStore(redis) : new MemoryRateLimiterStore());
}
const rateLimited = t.middleware(async ({ ctx, path, next }) => {
  const tenant = (ctx as RequestContext & { tenant?: ResolvedTenant }).tenant;
  if (!tenant)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'rate limiting requires tenant context' });
  if (!limiter) configureRateLimiter();
  await (limiter as RateLimiter).consume(tenant.context.tenantId, tenant.actorRef.id, path); // throws TOO_MANY_REQUESTS with retry-after
  return next();
});

/** Mutations additionally require an idempotency key header and, for cookie sessions, a CSRF token. */
const idempotencyKey = t.middleware(async ({ ctx, path, getRawInput, next }) => {
  const header = ctx.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || key.length > 120)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'IDEMPOTENCY_KEY_REQUIRED' });
  if (ctx.cookieSession && (!ctx.csrf.header || ctx.csrf.header !== ctx.csrf.cookie))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'CSRF token missing or invalid' });
  const requestHash = hashRequest(path, await getRawInput());
  return next({ ctx: { ...ctx, idempotency: { key, path, requestHash } } });
});

export const publicProcedure = t.procedure.use(domainErrors);
export const authedProcedure = t.procedure.use(domainErrors).use(authed);
export const tenantQuery = t.procedure.use(domainErrors).use(tenantScoped).use(rateLimited);
export const tenantMutation = t.procedure
  .use(domainErrors)
  .use(tenantScoped)
  .use(rateLimited)
  .use(idempotencyKey);
export const router = t.router;
export const mergeRouters = t.mergeRouters;

export type TenantCtx = RequestContext & { tenant: ResolvedTenant };
export type MutationCtx = TenantCtx & { idempotency: { key: string; path: string; requestHash: string } };
