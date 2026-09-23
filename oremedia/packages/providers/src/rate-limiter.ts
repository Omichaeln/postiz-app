import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';

/** Provider-side rate-limit accounting (spec 14.5, 17.4). Scopes come from the capability register. */
export interface RateLimiter {
  acquire(providerKey: string, tenantId: string): Promise<void>;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Token buckets per (scope, key). Waits (bounded) for a token rather than failing, so bursts are smoothed. */
export class MemoryProviderRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(
    private readonly capabilities: (providerKey: string) => ProviderCapabilityV1 | undefined,
    private readonly maxWaitMs = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async acquire(providerKey: string, tenantId: string): Promise<void> {
    const cap = this.capabilities(providerKey);
    if (!cap) return;
    for (const limit of cap.rateLimits) {
      const key = limit.scope === 'app' ? `${providerKey}:app` : `${providerKey}:${limit.scope}:${tenantId}`;
      await this.take(key, limit.limit, limit.windowSec);
    }
  }

  private async take(key: string, limit: number, windowSec: number): Promise<void> {
    const rate = limit / (windowSec * 1000); // tokens per ms
    const deadline = this.now() + this.maxWaitMs;
    for (;;) {
      const t = this.now();
      const b = this.buckets.get(key) ?? { tokens: limit, updatedAt: t };
      b.tokens = Math.min(limit, b.tokens + (t - b.updatedAt) * rate);
      b.updatedAt = t;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        this.buckets.set(key, b);
        return;
      }
      this.buckets.set(key, b);
      if (t >= deadline) throw new ProviderRateLimitWaitExceeded(key);
      await new Promise((r) => setTimeout(r, Math.min(250, Math.ceil((1 - b.tokens) / rate))));
    }
  }
}

export class ProviderRateLimitWaitExceeded extends Error {
  constructor(key: string) {
    super(`rate limit wait exceeded for ${key}`);
    this.name = 'ProviderRateLimitWaitExceeded';
  }
}
