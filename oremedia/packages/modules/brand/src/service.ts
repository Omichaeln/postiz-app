import type { z } from 'zod';
import { BrandCreate } from '@oremedia/contracts/brand';
import { NotFoundError, ValidationFailedError } from '@oremedia/contracts/errors';
import type { ResolvedActor } from '@oremedia/contracts/policy';
import { requireTenant, type Tx } from '@oremedia/db';
import { newId } from '@oremedia/domain/ids';
import { policy } from '@oremedia/module-access';
import { entitlements } from '@oremedia/module-billing';
import { audit } from '@oremedia/module-operations';
import { BrandRepository } from './repositories';

const brandsRepo = new BrandRepository();

export const brandService = {
  async create(actor: ResolvedActor, input: z.infer<typeof BrandCreate>, tx: Tx) {
    const parsed = BrandCreate.parse(input);
    const { tenantId } = requireTenant();
    await policy.assert(actor, 'brand.edit_standards', { type: 'tenant', tenantId, id: tenantId }, {}, tx);
    await entitlements.assert(tenantId, 'brands', tx);
    const id = newId('brand');
    await brandsRepo.create(
      {
        id,
        name: parsed.name,
        timezone: parsed.timezone,
        defaultLocale: parsed.defaultLocale,
        status: 'setup',
      },
      tx,
    );
    await audit.record(
      { kind: actor.kind, id: actor.id },
      'brand.create',
      { type: 'brand', id },
      'allowed',
      tx,
      { brandId: id },
    );
    return { brandId: id };
  },

  async list(actor: ResolvedActor, tx?: Tx) {
    const rows = await brandsRepo.listVisible(tx);
    return rows.map((b) => ({
      id: b.id,
      name: b.name,
      timezone: b.timezone,
      defaultLocale: b.defaultLocale,
      status: b.status,
      publishedVersionId: b.publishedVersionId,
      version: b.version,
    }));
  },

  /** Any brand id from a client is loaded through the scoped repository first; a foreign id is NOT_FOUND. */
  async get(actor: ResolvedActor, brandId: string, tx?: Tx) {
    const b = await brandsRepo.getById(brandId, tx);
    await policy.assert(
      actor,
      'brand.read',
      { type: 'brand', tenantId: b.tenantId, brandId: b.id, id: b.id },
      {},
      tx,
    );
    return {
      id: b.id,
      name: b.name,
      timezone: b.timezone,
      defaultLocale: b.defaultLocale,
      status: b.status,
      publishedVersionId: b.publishedVersionId,
      version: b.version,
    };
  },

  /** Validates that every id exists in the current tenant; throws NOT_FOUND for the first that does not. */
  async assertExist(brandIds: string[], tx?: Tx): Promise<void> {
    const missing = await brandsRepo.missing(brandIds, tx);
    if (missing[0]) throw new NotFoundError('Brand', missing[0]);
  },

  async assertValidGrantBrands(brandIds: string[], tx?: Tx): Promise<void> {
    const missing = await brandsRepo.missing(brandIds, tx);
    if (missing.length)
      throw new ValidationFailedError(
        missing.map((m) => ({ path: 'grants.brandIds', issue: `unknown brand ${m}` })),
      );
  },

  count: (tx?: Tx) => brandsRepo.countAll(tx),
};
