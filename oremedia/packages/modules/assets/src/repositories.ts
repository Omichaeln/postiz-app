import { and, desc, eq, gt, inArray, isNotNull, isNull, like, lte, or, type SQL } from 'drizzle-orm';
import type { AssetKind, AssetPurpose } from '@oremedia/contracts/assets';
import type { Page, PageRequest } from '@oremedia/contracts/pagination';
import { ID_LIST_MAX } from '@oremedia/contracts/pagination';
import { BrandScopedRepository, requireTenant, type Tx } from '@oremedia/db';
import {
  assetDerivatives,
  assetGrants,
  assetUsages,
  assetVersions,
  assets,
  uploadIntents,
  usageRights,
} from '@oremedia/db/schema/assets';
import { decodeCursor, encodeCursor } from '@oremedia/module-operations';

export type AssetRow = typeof assets.$inferSelect;
export type AssetVersionRow = typeof assetVersions.$inferSelect;
export type AssetDerivativeRow = typeof assetDerivatives.$inferSelect;
export type UsageRightsRow = typeof usageRights.$inferSelect;
export type AssetGrantRow = typeof assetGrants.$inferSelect;
export type AssetUsageRow = typeof assetUsages.$inferSelect;
export type UploadIntentRow = typeof uploadIntents.$inferSelect;

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function page<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const next = rows.length > limit ? rows[limit] : undefined;
  return { items, nextCursor: next ? encodeCursor({ id: next.id }) : null };
}

export interface EligibleCandidateRow {
  asset: AssetRow;
  version: AssetVersionRow | null;
  rights: UsageRightsRow | null;
  grantId: string | null;
}

export interface EligibilityFilter {
  brandId: string;
  purpose: AssetPurpose;
  kinds: AssetKind[];
  rightsRequired: boolean;
  expiryThreshold: Date;
  now: Date;
  text?: string;
}

export class AssetRepository extends BrandScopedRepository<typeof assets> {
  constructor() {
    super(assets);
  }
  async create(values: Omit<typeof assets.$inferInsert, 'tenantId'> & { brandId: string }, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(id: string, expectedVersion: number, values: Partial<typeof assets.$inferInsert>, tx?: Tx) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Brand visibility check for a brand id the caller wants to act *as* (search, authoriseUse). */
  assertBrandVisible(brandId: string): void {
    this.assertBrandAccess(brandId);
  }
  /**
   * Tenant-scoped, not brand-filtered: eligibility (spec 9.2) may grant a version of a brand the actor cannot
   * otherwise see through an asset_grant; the grant is what decides, evaluated by the service.
   */
  async findInTenant(id: string, tx?: Tx): Promise<AssetRow | null> {
    const rows = await this.conn(tx)
      .select()
      .from(assets)
      .where(this.scope(eq(assets.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }
  /**
   * Spec 9.2 filter, SQL-expressible part: tenant, brand or active grant for the purpose, state approved, kind
   * compatible, rights present when required and not expiring inside the processing window. Channels and
   * territories live in JSON and are checked by evaluateEligibility on each row (JSON is never queried for
   * authorisation, spec 6.1). Ordered newest first; the cursor is the id of the next page's first row.
   */
  async findEligibleCandidates(
    f: EligibilityFilter,
    req: PageRequest,
    tx?: Tx,
  ): Promise<Page<EligibleCandidateRow>> {
    this.assertBrandAccess(f.brandId);
    const { tenantId } = requireTenant();
    if (f.kinds.length === 0) return { items: [], nextCursor: null };
    const clauses: SQL[] = [
      or(eq(assets.brandId, f.brandId), isNotNull(assetGrants.id)) as SQL,
      eq(assets.state, 'approved'),
      inArray(assets.kind, f.kinds),
      or(
        isNull(usageRights.id),
        isNull(usageRights.expiresAt),
        gt(usageRights.expiresAt, f.expiryThreshold),
      ) as SQL,
    ];
    if (f.rightsRequired) clauses.push(eq(assets.rightsState, 'recorded'), isNotNull(usageRights.id));
    if (f.text) clauses.push(like(assets.name, `%${escapeLike(f.text)}%`));
    const cursor = req.cursor ? decodeCursor(req.cursor) : null;
    if (cursor) clauses.push(lte(assets.id, cursor.id));
    const rows = await this.conn(tx)
      .select({ asset: assets, version: assetVersions, rights: usageRights, grantId: assetGrants.id })
      .from(assets)
      .leftJoin(
        assetVersions,
        and(eq(assetVersions.tenantId, assets.tenantId), eq(assetVersions.id, assets.currentVersionId)),
      )
      .leftJoin(
        usageRights,
        and(eq(usageRights.tenantId, assets.tenantId), eq(usageRights.assetId, assets.id)),
      )
      .leftJoin(
        assetGrants,
        and(
          eq(assetGrants.tenantId, tenantId),
          eq(assetGrants.assetId, assets.id),
          eq(assetGrants.granteeBrandId, f.brandId),
          eq(assetGrants.purpose, f.purpose),
          or(isNull(assetGrants.expiresAt), gt(assetGrants.expiresAt, f.now)),
        ),
      )
      .where(this.scope(and(...clauses) as SQL))
      .orderBy(desc(assets.id))
      .limit(req.limit + 1);
    const items = rows.slice(0, req.limit);
    const next = rows.length > req.limit ? rows[req.limit] : undefined;
    return { items, nextCursor: next ? encodeCursor({ id: next.asset.id }) : null };
  }
}

/** Insert-only (spec 6.1): versions are never updated; a new upload becomes a new version. */
export class AssetVersionRepository extends BrandScopedRepository<typeof assetVersions> {
  constructor() {
    super(assetVersions);
  }
  async create(values: Omit<typeof assetVersions.$inferInsert, 'tenantId'> & { brandId: string }, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async findInTenant(id: string, tx?: Tx): Promise<AssetVersionRow | null> {
    const rows = await this.conn(tx)
      .select()
      .from(assetVersions)
      .where(this.scope(eq(assetVersions.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }
  /** Dedupe within the brand (spec 9.1 step 5): index ix_asset_version_hash (tenant, brand, hash). */
  async findByHash(brandId: string, contentHash: string, tx?: Tx): Promise<AssetVersionRow | null> {
    const rows = await this.conn(tx)
      .select()
      .from(assetVersions)
      .where(this.brandScope(brandId, eq(assetVersions.contentHash, contentHash)))
      .limit(1);
    return rows[0] ?? null;
  }
  async listForAsset(assetId: string, req: PageRequest, tx?: Tx): Promise<Page<AssetVersionRow>> {
    const cursor = req.cursor ? decodeCursor(req.cursor) : null;
    const clauses: SQL[] = [eq(assetVersions.assetId, assetId)];
    if (cursor) clauses.push(lte(assetVersions.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(assetVersions)
      .where(this.scope(and(...clauses) as SQL))
      .orderBy(desc(assetVersions.id))
      .limit(req.limit + 1);
    return page(rows, req.limit);
  }
  /** Bounded to ID_LIST_MAX most recent versions (spec 7.4: no unbounded IN lists). */
  async idsForAsset(assetId: string, tx?: Tx): Promise<string[]> {
    const rows = await this.conn(tx)
      .select({ id: assetVersions.id })
      .from(assetVersions)
      .where(this.scope(eq(assetVersions.assetId, assetId)))
      .orderBy(desc(assetVersions.id))
      .limit(ID_LIST_MAX);
    return rows.map((r) => r.id);
  }
}

/** Insert-only. `createRelease` and usages use the tenant scope because a release or a usage can be minted for a
 *  grantee brand that may not see the source brand (the grant, checked by authoriseUse, is the permission). */
export class AssetDerivativeRepository extends BrandScopedRepository<typeof assetDerivatives> {
  constructor() {
    super(assetDerivatives);
  }
  async create(
    values: Omit<typeof assetDerivatives.$inferInsert, 'tenantId'> & { brandId: string },
    tx?: Tx,
  ) {
    await this.insertBrandScoped(values, tx);
  }
  async createRelease(values: Omit<typeof assetDerivatives.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async listForVersion(assetVersionId: string, tx?: Tx): Promise<AssetDerivativeRow[]> {
    return this.conn(tx)
      .select()
      .from(assetDerivatives)
      .where(this.scope(eq(assetDerivatives.assetVersionId, assetVersionId)))
      .orderBy(desc(assetDerivatives.id))
      .limit(ID_LIST_MAX);
  }
  async find(assetVersionId: string, purpose: string, tx?: Tx): Promise<AssetDerivativeRow | null> {
    const rows = await this.conn(tx)
      .select()
      .from(assetDerivatives)
      .where(
        this.scope(
          and(eq(assetDerivatives.assetVersionId, assetVersionId), eq(assetDerivatives.purpose, purpose)),
        ),
      )
      .orderBy(desc(assetDerivatives.id))
      .limit(1);
    return rows[0] ?? null;
  }
}

export class UsageRightsRepository extends BrandScopedRepository<typeof usageRights> {
  constructor() {
    super(usageRights);
  }
  async create(values: Omit<typeof usageRights.$inferInsert, 'tenantId'> & { brandId: string }, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof usageRights.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
  /** Tenant-scoped: rights are read for eligibility of granted assets too. */
  async findForAsset(assetId: string, tx?: Tx): Promise<UsageRightsRow | null> {
    const rows = await this.conn(tx)
      .select()
      .from(usageRights)
      .where(this.scope(eq(usageRights.assetId, assetId)))
      .limit(1);
    return rows[0] ?? null;
  }
}

export class AssetGrantRepository extends BrandScopedRepository<typeof assetGrants> {
  constructor() {
    super(assetGrants);
  }
  async create(values: Omit<typeof assetGrants.$inferInsert, 'tenantId'> & { brandId: string }, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async find(
    assetId: string,
    granteeBrandId: string,
    purpose: string,
    tx?: Tx,
  ): Promise<AssetGrantRow | null> {
    const rows = await this.conn(tx)
      .select()
      .from(assetGrants)
      .where(
        this.scope(
          and(
            eq(assetGrants.assetId, assetId),
            eq(assetGrants.granteeBrandId, granteeBrandId),
            eq(assetGrants.purpose, purpose),
          ),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
  async findActive(
    assetId: string,
    granteeBrandId: string,
    purpose: string,
    now: Date,
    tx?: Tx,
  ): Promise<AssetGrantRow | null> {
    const g = await this.find(assetId, granteeBrandId, purpose, tx);
    if (!g) return null;
    return g.expiresAt && g.expiresAt.getTime() <= now.getTime() ? null : g;
  }
}

/** Insert-only: enables impact analysis (spec 6.3). */
export class AssetUsageRepository extends BrandScopedRepository<typeof assetUsages> {
  constructor() {
    super(assetUsages);
  }
  async record(values: Omit<typeof assetUsages.$inferInsert, 'tenantId'>, tx?: Tx): Promise<void> {
    await this.insertScoped(values, tx);
  }
  async listForVersions(versionIds: string[], req: PageRequest, tx?: Tx): Promise<Page<AssetUsageRow>> {
    if (versionIds.length === 0) return { items: [], nextCursor: null };
    const cursor = req.cursor ? decodeCursor(req.cursor) : null;
    const clauses: SQL[] = [inArray(assetUsages.assetVersionId, versionIds.slice(0, ID_LIST_MAX))];
    if (cursor) clauses.push(lte(assetUsages.id, cursor.id));
    const rows = await this.conn(tx)
      .select()
      .from(assetUsages)
      .where(this.scope(and(...clauses) as SQL))
      .orderBy(desc(assetUsages.id))
      .limit(req.limit + 1);
    return page(rows, req.limit);
  }
}

export class UploadIntentRepository extends BrandScopedRepository<typeof uploadIntents> {
  constructor() {
    super(uploadIntents);
  }
  async create(values: Omit<typeof uploadIntents.$inferInsert, 'tenantId'> & { brandId: string }, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async update(
    id: string,
    expectedVersion: number,
    values: Partial<typeof uploadIntents.$inferInsert>,
    tx?: Tx,
  ) {
    await this.updateScoped(id, expectedVersion, values, tx);
  }
}
