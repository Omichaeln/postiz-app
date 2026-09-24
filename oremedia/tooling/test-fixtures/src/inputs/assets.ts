import {
  assetDerivatives,
  assetVersions,
  assets,
  uploadIntents,
  usageRights,
} from '@oremedia/db/schema/assets';
import { sha256Hex } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { CrossTenantFixture, SeedExtension } from '../cross-tenant-inputs';

/** One entry per assets.* procedure, every id pointing at the foreign tenant (spec 19.3). */
export const ASSETS_INPUTS: Record<string, CrossTenantFixture> = {
  'assets.uploads.createIntent': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      kind: 'photo',
      declaredMime: 'image/png',
      declaredBytes: 1024,
      originalFilename: 'foreign.png',
    }),
  },
  'assets.uploads.complete': { buildInput: (f) => ({ intentId: f['uploadIntentId'] }) },
  'assets.search': {
    buildInput: (f) => ({ query: { brandId: f['brandId'], purpose: 'creative' }, page: { limit: 50 } }),
  },
  'assets.get': { buildInput: (f) => ({ assetId: f['assetId'] }) },
  'assets.versions.list': { buildInput: (f) => ({ assetId: f['assetId'], page: { limit: 50 } }) },
  'assets.rights.set': {
    buildInput: (f) => ({ assetId: f['assetId'], owner: 'x', permittedChannels: 'all', territories: 'all' }),
  },
  'assets.approve': { buildInput: (f) => ({ assetId: f['pendingAssetId'], expectedVersion: 0 }) },
  'assets.retire': { buildInput: (f) => ({ assetId: f['assetId'], expectedVersion: 0 }) },
  'assets.usages.list': { buildInput: (f) => ({ assetId: f['assetId'], page: { limit: 50 } }) },
  'assets.grants.create': {
    buildInput: (f) => ({ assetId: f['assetId'], granteeBrandId: f['brandId2'], purpose: 'creative' }),
  },
  'assets.media.signedUrl': {
    buildInput: (f) => ({ assetVersionId: f['assetVersionId'], derivative: 'original' }),
  },
};

/**
 * Per tenant: one approved asset with a version, a preview derivative and recorded rights, one pending asset with
 * a version, and one issued upload intent, all in brand 1. Returns the ids a foreign caller might try to use.
 */
export const ASSETS_SEED: SeedExtension | null = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const assetId = newId('asset');
  const assetVersionId = newId('assetVersion');
  const pendingAssetId = newId('asset');
  const pendingVersionId = newId('assetVersion');
  const uploadIntentId = newId('uploadIntent');
  const usageRightsId = newId('usageRights');
  const version = (id: string, asset: string) => ({
    id,
    tenantId,
    brandId,
    assetId: asset,
    number: 1,
    storageKey: `assets/${tenantId}/${brandId}/${asset}/${id}/original`,
    contentHash: sha256Hex(id),
    mime: 'image/png',
    bytes: 1234,
    width: 64,
    height: 64,
    provenance: { kind: 'upload' as const, uploadedByUserId: ownerUserId, originalFilename: 'seed.png' },
  });
  await db.insert(assets).values([
    {
      id: assetId,
      tenantId,
      brandId,
      kind: 'photo',
      name: 'Seed approved photo',
      currentVersionId: assetVersionId,
      state: 'approved',
      rightsState: 'recorded',
    },
    {
      id: pendingAssetId,
      tenantId,
      brandId,
      kind: 'photo',
      name: 'Seed pending photo',
      currentVersionId: pendingVersionId,
      state: 'pending_review',
      rightsState: 'unknown',
    },
  ]);
  await db
    .insert(assetVersions)
    .values([version(assetVersionId, assetId), version(pendingVersionId, pendingAssetId)]);
  await db.insert(assetDerivatives).values({
    id: newId('assetDerivative'),
    tenantId,
    brandId,
    assetVersionId,
    purpose: 'preview',
    transform: { op: 'resize', maxSide: 1024 },
    storageKey: `assets/${tenantId}/${brandId}/${assetId}/${assetVersionId}/preview`,
    contentHash: sha256Hex(`${assetVersionId}:preview`),
    mime: 'image/webp',
    width: 64,
    height: 64,
    bytes: 512,
  });
  await db.insert(usageRights).values({
    id: usageRightsId,
    tenantId,
    brandId,
    assetId,
    owner: 'Seed owner',
    permittedChannels: 'all',
    territories: 'all',
    releases: [],
    restrictions: [],
  });
  await db.insert(uploadIntents).values({
    id: uploadIntentId,
    tenantId,
    brandId,
    kind: 'photo',
    declaredMime: 'image/png',
    declaredBytes: 1024,
    maxBytes: 50 * 1024 * 1024,
    storageKey: `quarantine/${tenantId}/${uploadIntentId}`,
    originalFilename: 'seed-intent.png',
    state: 'issued',
    createdByUserId: ownerUserId,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return { assetId, assetVersionId, pendingAssetId, uploadIntentId, usageRightsId };
};
