import { and, eq, isNotNull } from 'drizzle-orm';
import { PlatformRepository, runAsPlatform, type Tx } from '@oremedia/db';
import { experimentVariants, experiments } from '@oremedia/db/schema/experiments';
import { linkClicks, trackedLinks } from '@oremedia/db/schema/measurement';

/**
 * Spec 15.4: the redirect service is stateless. A short code is global (unique index), so the lookup is a declared
 * platform read that returns the destination and the ids a click needs, never tenant content beyond that. Reads
 * are cached in memory for a short time; writes are buffered (click-buffer.ts) and never block the redirect.
 *
 * Spec 16.6: the entry link of a running randomised link experiment (experiment id set, no variant) resolves with
 * its arms: one tracked link per experiment variant, with the variant's allocation weight. The redirector assigns
 * the visitor to an arm and records the click on the arm's link, so clicks are the exposures per variant.
 */
export interface ResolvedArm {
  /** The arm's tracked link: the click is recorded against it. */
  trackedLinkId: string;
  variantId: string;
  destination: string;
  allocationWeight: number;
}
export interface ResolvedLink {
  id: string;
  tenantId: string;
  brandId: string;
  destination: string;
  experimentId: string | null;
  /** The arms, sorted by variant id, while the link is the entry of a running experiment; otherwise null. */
  arms: ResolvedArm[] | null;
}

class TrackedLinkReader extends PlatformRepository {
  async byShortCode(shortCode: string): Promise<ResolvedLink | null> {
    const rows = await this.conn()
      .select({
        id: trackedLinks.id,
        tenantId: trackedLinks.tenantId,
        brandId: trackedLinks.brandId,
        destination: trackedLinks.destination,
        experimentId: trackedLinks.experimentId,
        experimentVariantId: trackedLinks.experimentVariantId,
      })
      .from(trackedLinks)
      .where(eq(trackedLinks.shortCode, shortCode))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const { experimentVariantId, ...link } = row;
    const arms =
      link.experimentId && !experimentVariantId
        ? await this.runningArms(link.tenantId, link.experimentId)
        : null;
    return { ...link, arms };
  }
  /** The experiment's arm links, only while it is running (a stopped experiment sends everyone to the entry). */
  private async runningArms(tenantId: string, experimentId: string): Promise<ResolvedArm[] | null> {
    const state = await this.conn()
      .select({ state: experiments.state })
      .from(experiments)
      .where(and(eq(experiments.tenantId, tenantId), eq(experiments.id, experimentId)))
      .limit(1);
    if (state[0]?.state !== 'running') return null;
    const arms = await this.conn()
      .select({
        trackedLinkId: trackedLinks.id,
        variantId: experimentVariants.id,
        destination: trackedLinks.destination,
        allocationWeight: experimentVariants.allocationWeight,
      })
      .from(trackedLinks)
      .innerJoin(
        experimentVariants,
        and(
          eq(experimentVariants.tenantId, trackedLinks.tenantId),
          eq(experimentVariants.id, trackedLinks.experimentVariantId),
        ),
      )
      .where(
        and(
          eq(trackedLinks.tenantId, tenantId),
          eq(trackedLinks.experimentId, experimentId),
          isNotNull(trackedLinks.experimentVariantId),
        ),
      );
    if (arms.length < 2) return null;
    return arms.sort((a, b) => a.variantId.localeCompare(b.variantId));
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
