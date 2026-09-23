import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ConflictError, NotFoundError, TenantContextMissingError } from '@oremedia/contracts';
import { newId } from '@oremedia/domain/ids';
import { createTestDatabase, type TestDatabase } from './testing';
import {
  BrandScopedRepository,
  TenantScopedRepository,
  runAsPlatform,
  PlatformRepository,
} from './scoped-repository';
import { runInTenant, type TenantContext } from './tenant-context';
import { withTransaction } from './transaction';
import { brands, tenants, approvedFacts, creativeDocuments, creativeRevisions } from './schema';
import type { Tx } from './client';

class BrandRepository extends TenantScopedRepository<typeof brands> {
  constructor() {
    super(brands);
  }
  async create(values: Omit<typeof brands.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertScoped(values, tx);
  }
  async rename(id: string, expectedVersion: number, name: string, tx?: Tx) {
    await this.updateScoped(id, expectedVersion, { name }, tx);
  }
}

class FactRepository extends BrandScopedRepository<typeof approvedFacts> {
  constructor() {
    super(approvedFacts);
  }
  async create(values: Omit<typeof approvedFacts.$inferInsert, 'tenantId'>, tx?: Tx) {
    await this.insertBrandScoped(values, tx);
  }
  async listForBrand(brandId: string) {
    return this.conn().select().from(approvedFacts).where(this.brandScope(brandId));
  }
}

class TenantCounts extends PlatformRepository {
  async count() {
    const rows = await this.conn().select({ id: tenants.id }).from(tenants);
    return rows.length;
  }
}

const ctx = (tenantId: string, brandIds: ReadonlySet<string> | 'all' = 'all'): TenantContext => ({
  tenantId,
  actor: { kind: 'user', id: 'usr_test' },
  brandIds,
  correlationId: 'corr_test',
});

describe('scoped repositories against MySQL 8', () => {
  let tdb: TestDatabase;
  const tenantA = newId('tenant');
  const tenantB = newId('tenant');
  const brandA = newId('brand');
  const brandA2 = newId('brand');
  const brandB = newId('brand');

  beforeAll(async () => {
    tdb = await createTestDatabase();
    await tdb.db.insert(tenants).values([
      { id: tenantA, name: 'A', slug: 'a-' + tenantA.slice(-6).toLowerCase() },
      { id: tenantB, name: 'B', slug: 'b-' + tenantB.slice(-6).toLowerCase() },
    ]);
    const repo = new BrandRepository();
    await runInTenant(ctx(tenantA), () =>
      repo.create({
        id: brandA,
        name: 'Brand A',
        timezone: 'Africa/Harare',
        defaultLocale: 'en',
        status: 'active',
      }),
    );
    await runInTenant(ctx(tenantA), () =>
      repo.create({
        id: brandA2,
        name: 'Brand A2',
        timezone: 'Africa/Harare',
        defaultLocale: 'en',
        status: 'active',
      }),
    );
    await runInTenant(ctx(tenantB), () =>
      repo.create({
        id: brandB,
        name: 'Brand B',
        timezone: 'Europe/London',
        defaultLocale: 'en',
        status: 'active',
      }),
    );
  });

  afterAll(async () => {
    await tdb?.drop();
  });

  it('a query without tenant context fails loudly', async () => {
    const repo = new BrandRepository();
    await expect(repo.findById(brandA)).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it('a foreign tenant id produces NOT_FOUND, never data', async () => {
    const repo = new BrandRepository();
    await runInTenant(ctx(tenantA), async () => {
      expect(await repo.findById(brandB)).toBeNull();
      await expect(repo.getById(brandB)).rejects.toBeInstanceOf(NotFoundError);
      expect((await repo.getById(brandA)).name).toBe('Brand A');
    });
  });

  it('inserts are stamped with the context tenant, not a caller-supplied one', async () => {
    const repo = new BrandRepository();
    const id = newId('brand');
    await runInTenant(ctx(tenantA), () =>
      repo.create({ id, name: 'Stamped', timezone: 'UTC', defaultLocale: 'en', status: 'setup' }),
    );
    const rows = await tdb.db.select().from(brands).where(eq(brands.id, id));
    expect(rows[0]?.tenantId).toBe(tenantA);
  });

  it('updates require id + tenant + expected version (optimistic concurrency)', async () => {
    const repo = new BrandRepository();
    await runInTenant(ctx(tenantA), async () => {
      await repo.rename(brandA, 0, 'Brand A renamed');
      expect((await repo.getById(brandA)).version).toBe(1);
      await expect(repo.rename(brandA, 0, 'stale write')).rejects.toBeInstanceOf(ConflictError);
    });
    await runInTenant(ctx(tenantB), async () => {
      // Correct version but wrong tenant: zero rows affected → conflict, never a cross-tenant write.
      await expect(repo.rename(brandA, 1, 'from tenant B')).rejects.toBeInstanceOf(ConflictError);
    });
    const rows = await tdb.db.select().from(brands).where(eq(brands.id, brandA));
    expect(rows[0]?.name).toBe('Brand A renamed');
  });

  it('brand-scoped repositories hide brands outside ctx.brandIds and refuse writes to them', async () => {
    const facts = new FactRepository();
    const restricted = ctx(tenantA, new Set([brandA]));
    await runInTenant(restricted, () =>
      facts.create({
        id: newId('approvedFact'),
        brandId: brandA,
        kind: 'claim',
        statement: 'ok',
        evidence: [],
        state: 'proposed',
        proposedByKind: 'user',
        proposedById: 'usr_test',
      }),
    );
    await runInTenant(restricted, async () => {
      await expect(
        facts.create({
          id: newId('approvedFact'),
          brandId: brandA2,
          kind: 'claim',
          statement: 'no',
          evidence: [],
          state: 'proposed',
          proposedByKind: 'user',
          proposedById: 'usr_test',
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(facts.listForBrand(brandA2)).rejects.toBeInstanceOf(NotFoundError);
      expect((await facts.listForBrand(brandA)).length).toBe(1);
    });
    const all = ctx(tenantA, 'all');
    const factInA2 = newId('approvedFact');
    await runInTenant(all, () =>
      facts.create({
        id: factInA2,
        brandId: brandA2,
        kind: 'claim',
        statement: 'a2',
        evidence: [],
        state: 'proposed',
        proposedByKind: 'user',
        proposedById: 'usr_test',
      }),
    );
    await runInTenant(restricted, async () => {
      expect(await facts.findById(factInA2)).toBeNull();
    });
  });

  it("composite integrity: a child row cannot point at another tenant's or brand's parent", async () => {
    // creative_revisions (tenant_id, brand_id, document_id) → creative_documents (tenant_id, brand_id, id)
    const docId = newId('creativeDocument');
    await tdb.db
      .insert(creativeDocuments)
      .values({ id: docId, tenantId: tenantA, brandId: brandA, title: 'Doc', schemaVersion: 1 });
    const badRevision = {
      id: newId('creativeRevision'),
      tenantId: tenantB, // wrong tenant for this document
      brandId: brandA,
      documentId: docId,
      number: 1,
      brandVersionId: 'bv_x',
      authorKind: 'user' as const,
      authorId: 'usr_test',
      changeSummary: 'x',
      operations: { baseRevisionId: 'none', operations: [], summary: '', origin: 'user' as const },
      snapshot: { schemaVersion: 1 as const, brandVersionId: 'bv_x', pages: [], variants: [] },
      contentHash: 'a'.repeat(64),
    };
    await expect(tdb.db.insert(creativeRevisions).values(badRevision)).rejects.toMatchObject({
      cause: { code: 'ER_NO_REFERENCED_ROW_2' },
    });
    await expect(
      tdb.db.insert(creativeRevisions).values({ ...badRevision, tenantId: tenantA, brandId: brandA2 }),
    ).rejects.toMatchObject({ cause: { code: 'ER_NO_REFERENCED_ROW_2' } });
    // The right (tenant, brand, document) triple succeeds.
    await tdb.db.insert(creativeRevisions).values({ ...badRevision, tenantId: tenantA, brandId: brandA });
  });

  it('withTransaction joins an outer transaction and rolls back atomically', async () => {
    const repo = new BrandRepository();
    const id = newId('brand');
    await runInTenant(ctx(tenantA), async () => {
      await expect(
        withTransaction(async (tx) => {
          await withTransaction(tx, (inner) =>
            repo.create(
              { id, name: 'Rolled back', timezone: 'UTC', defaultLocale: 'en', status: 'setup' },
              inner,
            ),
          );
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await repo.findById(id)).toBeNull();
    });
  });

  it('platform repositories run only inside an explicit platform job', async () => {
    const counts = new TenantCounts();
    await expect(counts.count()).rejects.toBeInstanceOf(TenantContextMissingError);
    await runInTenant(ctx(tenantA), async () => {
      await expect(counts.count()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        reason: 'platform_repository_requires_platform_context',
      });
    });
    expect(await runAsPlatform('billing-rollup', 'corr', () => counts.count())).toBeGreaterThanOrEqual(2);
  });
});
