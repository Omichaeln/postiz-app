import { eq } from 'drizzle-orm';
import { PlatformRepository, runAsPlatform, type Tx } from '@oremedia/db';
import { linkClicks, trackedLinks } from '@oremedia/db/schema/measurement';

/**
 * Spec 15.4: the redirect service is stateless. A short code is global (unique index), so the lookup is a declared
 * platform read that returns the destination and the ids a click needs, never tenant content beyond that. Reads
 * are cached in memory for a short time; writes are buffered (click-buffer.ts) and never block the redirect.
 */
export interface ResolvedLink {
  id: string;
  tenantId: string;
  brandId: string;
  destination: string;
}

class TrackedLinkReader extends PlatformRepository {
  async byShortCode(shortCode: string): Promise<ResolvedLink | null> {
    const rows = await this.conn()
      .select({
        id: trackedLinks.id,
        tenantId: trackedLinks.tenantId,
        brandId: trackedLinks.brandId,
        destination: trackedLinks.destination,
      })
      .from(trackedLinks)
      .where(eq(trackedLinks.shortCode, shortCode))
      .limit(1);
    return rows[0] ?? null;
  }
  async insertClicks(rows: Array<typeof linkClicks.$inferInsert>, tx?: Tx): Promise<void> {
    if (rows.length === 0) return;
    await (tx ?? this.conn()).insert(linkClicks).values(rows);
  }
}

const reader = new TrackedLinkReader();

export interface LinkCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
}

/** A small LRU-ish cache: the redirect path must not hit the database on every click of a viral post. */
export function createLinkResolver(opts: LinkCacheOptions = {}) {
  const ttlMs = opts.ttlMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 10_000;
  const cache = new Map<string, { value: ResolvedLink | null; expiresAt: number }>();
  return {
    async resolve(shortCode: string, correlationId: string): Promise<ResolvedLink | null> {
      const hit = cache.get(shortCode);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const value = await runAsPlatform('redirector', correlationId, () => reader.byShortCode(shortCode));
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
      cache.set(shortCode, { value, expiresAt: Date.now() + ttlMs });
      return value;
    },
    insertClicks: (rows: Array<typeof linkClicks.$inferInsert>) =>
      runAsPlatform('redirector', 'click-buffer', () => reader.insertClicks(rows)),
  };
}

export type LinkResolver = ReturnType<typeof createLinkResolver>;
