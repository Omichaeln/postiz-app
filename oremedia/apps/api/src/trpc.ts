import { initTRPC, TRPCError, type TRPC_ERROR_CODE_KEY } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import { runInTenant } from '@oremedia/db';
import {
  PolicyDeniedError,
  isOremediaError,
  toErrorEnvelope,
  type ErrorCode,
  type ErrorEnvelope,
} from '@oremedia/contracts/errors';
import { apiKeyAllows, resolveTenantContext, type ResolvedTenant } from '@oremedia/module-access';
import { surfaceAutonomyFor } from '@oremedia/module-agents';
import type { ResolvedActorServicePrincipal } from '@oremedia/contracts/policy';
import {
  audit,
  MemoryRateLimiterStore,
  RateLimiter,
  RedisRateLimiterStore,
  hashRequest,
} from '@oremedia/module-operations';
import type { ApiScope } from '@oremedia/contracts/access';
import { withLogContext } from '@oremedia/observability';
import type { RequestContext } from './context';
import { scopeForProcedure } from './scopes';

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
/**
 * Spec 7.2: a domain error becomes its tRPC code (and HTTP status), not INTERNAL_SERVER_ERROR. In tRPC 11 a
 * middleware's next() resolves to a failed result rather than throwing, so the remap inspects the result.
 */
const domainErrors = t.middleware(async ({ next, ctx }) => {
  const result = await withLogContext({ correlationId: ctx.correlationId }, () => next());
  if (!result.ok) {
    const cause = result.error.cause;
    if (isOremediaError(cause) && result.error.code !== TRPC_CODE[cause.code])
      throw new TRPCError({ code: TRPC_CODE[cause.code], message: cause.message, cause });
  }
  return result;
});

const authed = t.middleware(async ({ ctx, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, principal: ctx.principal } });
});

type OperatorPrincipal = Extract<NonNullable<RequestContext['principal']>, { kind: 'platform_operator' }>;

/**
 * Spec 5.7: every request made inside a support session is audited with its supportSessionId, whatever the
 * procedure does itself (a read that consults no policy included), with the outcome of the request. Recorded in the
 * session's tenant on its own connection, after the request's transaction has committed or rolled back.
 */
function auditSupportRequest(
  principal: OperatorPrincipal,
  correlationId: string,
  path: string,
  outcome: { ok: true } | { ok: false; reason: string },
): Promise<string> {
  const context = {
    tenantId: principal.tenantId,
    actor: { kind: 'platform_operator' as const, id: principal.operatorId },
    brandIds: 'all' as const,
    correlationId,
    supportSessionId: principal.supportSessionId,
  };
  return runInTenant(context, () =>
    audit.record(
      context.actor,
      'support.request',
      { type: 'support_session', id: principal.supportSessionId },
      outcome.ok ? 'allowed' : { allowed: false, reason: outcome.reason },
      undefined,
      { path: path.slice(0, 120) },
    ),
  );
}

const failureReason = (err: unknown): string =>
  err instanceof PolicyDeniedError ? err.reason : isOremediaError(err) ? err.code : 'INTERNAL';

/** Tenant procedures: tenant is resolved server-side from the session's selected company and verified membership. */
const tenantScoped = t.middleware(async ({ ctx, path, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const principal = ctx.principal;
  const operator = principal.kind === 'platform_operator' ? principal : null;
  let tenant: ResolvedTenant;
  try {
    tenant = await resolveTenantContext(principal, ctx.requestedTenantId, ctx.correlationId);
  } catch (err) {
    if (operator)
      await auditSupportRequest(operator, ctx.correlationId, path, { ok: false, reason: failureReason(err) });
    throw err;
  }
  // Spec 12.5: an API key acts at min(principal max, tenant policy, entitlement) for this request; without it every
  // service-principal write would be evaluated at the lowest mode and refused.
  if (tenant.actor.kind === 'service_principal') {
    const requestAutonomy = await runInTenant(tenant.context, () =>
      surfaceAutonomyFor(
        tenant.actor as ResolvedActorServicePrincipal,
        tenant.context.tenantId,
        ctx.correlationId,
      ),
    );
    tenant = { ...tenant, actor: { ...tenant.actor, requestAutonomy } };
  }
  const resolved = tenant;
  const result = await runInTenant(resolved.context, () =>
    withLogContext({ tenantId: resolved.context.tenantId }, () =>
      next({ ctx: { ...ctx, principal, tenant: resolved } }),
    ),
  );
  if (operator)
    await auditSupportRequest(
      operator,
      ctx.correlationId,
      path,
      result.ok ? { ok: true } : { ok: false, reason: failureReason(result.error.cause ?? result.error) },
    );
  return result;
});

let limiter: RateLimiter | null = null;
export function configureRateLimiter(redis?: ConstructorParameters<typeof RedisRateLimiterStore>[0]): void {
  limiter = new RateLimiter(redis ? new RedisRateLimiterStore(redis) : new MemoryRateLimiterStore());
}
/** The principal's own id, for procedures that run before a tenant is resolved (portfolio, switchCompany). */
function principalId(principal: NonNullable<RequestContext['principal']>): string {
  switch (principal.kind) {
    case 'user':
      return principal.userId;
    case 'api_client':
      return principal.apiClientId;
    case 'external_reviewer':
      return principal.linkId;
    case 'platform_operator':
      return principal.operatorId;
  }
}
/**
 * Spec 4.3 rate limit, per tenant and per principal once the tenant is resolved, per principal before that. Shared
 * by tRPC, public REST (which calls the procedures) and MCP (which passes its method path).
 */
export async function consumeRateLimit(
  principal: NonNullable<RequestContext['principal']>,
  tenant: ResolvedTenant | undefined,
  path: string,
): Promise<void> {
  if (!limiter) configureRateLimiter();
  const scope = tenant ? tenant.context.tenantId : `principal:${principalId(principal)}`;
  const actorId = tenant ? tenant.actorRef.id : principalId(principal);
  await (limiter as RateLimiter).consume(scope, actorId, path); // throws TOO_MANY_REQUESTS with retry-after
}

/** Tenant procedures are limited per tenant and per principal; authed-only procedures per principal. */
const rateLimited = t.middleware(async ({ ctx, path, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await consumeRateLimit(ctx.principal, (ctx as RequestContext & { tenant?: ResolvedTenant }).tenant, path);
  return next();
});

/**
 * Spec 7.6 per-key scopes: an API client key must carry the scope of the procedure (scopes.ts); sessions are not
 * scoped. Inside a tenant the denial is audited like a policy denial, so every surface leaves the same trail.
 */
export async function assertApiScope(
  principal: NonNullable<RequestContext['principal']>,
  tenant: ResolvedTenant | undefined,
  scope: ApiScope,
  path: string,
): Promise<void> {
  if (principal.kind !== 'api_client' || apiKeyAllows(principal.scopes, scope)) return;
  if (tenant)
    await audit.record(
      tenant.actorRef,
      'api.scope',
      { type: 'api_client', id: principal.apiClientId },
      { allowed: false, reason: 'scope_missing' },
      undefined,
      { scope, path: path.slice(0, 120) },
    );
  throw new PolicyDeniedError('scope_missing', `This API key does not have the ${scope} scope`);
}

const scoped = t.middleware(async ({ ctx, path, type, next }) => {
  if (!ctx.principal) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const tenant = (ctx as RequestContext & { tenant?: ResolvedTenant }).tenant;
  await assertApiScope(ctx.principal, tenant, scopeForProcedure(path, type), path);
  return next();
});

/** Spec 18: every mutation made with a cookie session presents the CSRF double-submit token; bearer callers are exempt. */
const csrfGuarded = t.middleware(async ({ ctx, next }) => {
  if (ctx.cookieSession && (!ctx.csrf.header || ctx.csrf.header !== ctx.csrf.cookie))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'CSRF token missing or invalid' });
  return next();
});

/** Tenant mutations additionally require an idempotency key header. */
const idempotencyKey = t.middleware(async ({ ctx, path, getRawInput, next }) => {
  const header = ctx.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || key.length > 120)
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'IDEMPOTENCY_KEY_REQUIRED' });
  const requestHash = hashRequest(path, await getRawInput());
  return next({ ctx: { ...ctx, idempotency: { key, path, requestHash } } });
});

export const publicProcedure = t.procedure.use(domainErrors);
export const authedProcedure = t.procedure.use(domainErrors).use(authed).use(scoped).use(rateLimited);
/** Session-level mutations (no tenant yet, e.g. switchCompany): rate-limited per principal and CSRF-guarded. */
export const authedMutation = authedProcedure.use(csrfGuarded);
export const tenantQuery = t.procedure.use(domainErrors).use(tenantScoped).use(scoped).use(rateLimited);
export const tenantMutation = t.procedure
  .use(domainErrors)
  .use(tenantScoped)
  .use(scoped)
  .use(rateLimited)
  .use(csrfGuarded)
  .use(idempotencyKey);
export const router = t.router;
export const mergeRouters = t.mergeRouters;

export type TenantCtx = RequestContext & { tenant: ResolvedTenant };
export type MutationCtx = TenantCtx & { idempotency: { key: string; path: string; requestHash: string } };
