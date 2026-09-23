import { RateLimitedError } from '@oremedia/contracts/errors';
import { count, METRIC } from '@oremedia/observability';

/**
 * Spec 4.3: rate limit per principal and per tenant. Sliding window in Redis when configured; an in-memory
 * limiter otherwise (single-process development and tests). Never the durable record (spec 3.1).
 */
export interface RateLimitPolicy {
  limit: number;
  windowSec: number;
}

export interface RateLimiterStore {
  hit(key: string, windowSec: number): Promise<{ count: number; ttlMs: number }>;
}

export class MemoryRateLimiterStore implements RateLimiterStore {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  async hit(key: string, windowSec: number) {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      return { count: 1, ttlMs: windowSec * 1000 };
    }
    b.count++;
    return { count: b.count, ttlMs: b.resetAt - now };
  }
}

export interface RedisLike {
  multi(): {
    incr(k: string): RedisMulti;
    pttl(k: string): RedisMulti;
    exec(): Promise<Array<[Error | null, unknown]> | null>;
  };
  pexpire(k: string, ms: number): Promise<unknown>;
}
interface RedisMulti {
  incr(k: string): RedisMulti;
  pttl(k: string): RedisMulti;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export class RedisRateLimiterStore implements RateLimiterStore {
  constructor(private readonly redis: RedisLike) {}
  async hit(key: string, windowSec: number) {
    const res = await this.redis.multi().incr(key).pttl(key).exec();
    const c = Number(res?.[0]?.[1] ?? 1);
    let ttl = Number(res?.[1]?.[1] ?? -1);
    if (ttl < 0) {
      await this.redis.pexpire(key, windowSec * 1000);
      ttl = windowSec * 1000;
    }
    return { count: c, ttlMs: ttl };
  }
}

const DEFAULT_PRINCIPAL: RateLimitPolicy = { limit: 600, windowSec: 60 };
const DEFAULT_TENANT: RateLimitPolicy = { limit: 6000, windowSec: 60 };
/** Expensive paths get tighter limits (per principal). */
const PATH_POLICIES: Record<string, RateLimitPolicy> = {
  'agents.runs.start': { limit: 30, windowSec: 60 },
  'creative.renders.request': { limit: 60, windowSec: 60 },
  'assets.uploads.createIntent': { limit: 120, windowSec: 60 },
  'publishing.publications.schedule': { limit: 120, windowSec: 60 },
};

export class RateLimiter {
  constructor(private readonly store: RateLimiterStore) {}

  /** Throws RATE_LIMITED with retry-after (spec 7.1). */
  async consume(tenantId: string, principalId: string, path: string): Promise<void> {
    const perPath = PATH_POLICIES[path];
    const checks: Array<[string, RateLimitPolicy]> = [
      [`rl:t:${tenantId}:${DEFAULT_TENANT.windowSec}`, DEFAULT_TENANT],
      [`rl:p:${tenantId}:${principalId}:${DEFAULT_PRINCIPAL.windowSec}`, DEFAULT_PRINCIPAL],
    ];
    if (perPath) checks.push([`rl:pp:${tenantId}:${principalId}:${path}`, perPath]);
    for (const [key, policy] of checks) {
      const { count: c, ttlMs } = await this.store.hit(key, policy.windowSec);
      if (c > policy.limit) {
        count(METRIC.policyDenials, 1, { reason: 'rate_limited' });
        throw new RateLimitedError(Math.max(1000, ttlMs));
      }
    }
  }
}
