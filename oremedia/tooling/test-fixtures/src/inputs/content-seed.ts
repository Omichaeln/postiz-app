import { defaultPolicyDocument } from '@oremedia/contracts/brand';
import type { CopyDocumentV1 } from '@oremedia/contracts/content';
import type { Db } from '@oremedia/db';
import { policyVersions } from '@oremedia/db/schema/brand';
import {
  briefs,
  campaigns,
  channelVariants,
  contentPackages,
  contentRevisions,
} from '@oremedia/db/schema/content';
import { channelConnections, credentialRefs } from '@oremedia/db/schema/publishing';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

export const seedCopy = (text = 'Seeded caption'): CopyDocumentV1 => ({
  schemaVersion: 1,
  master: { text, factRefs: [] },
});

/**
 * A package with revision 1 (draft) and one channel variant on a placeholder channel connection of the brand
 * (provider `fixture_provider`, placeholder credential). Shared by the content and review seeds.
 */
export async function seedContentPackage(
  db: Db,
  tenant: {
    tenantId: string;
    brandId: string;
    ownerUserId: string;
    brandVersionId: string;
    policyVersionId: string;
  },
  label: string,
) {
  const { tenantId, brandId } = tenant;
  const credentialRefId = newId('credentialRef');
  const channelConnectionId = newId('channelConnection');
  await db.insert(credentialRefs).values({
    id: credentialRefId,
    tenantId,
    kmsKeyId: 'fixture-kms-key',
    // VARBINARY columns travel as text (see the publishing envelope); placeholders within each column's length.
    wrappedDataKey: 'fixture-wrapped-key',
    ciphertext: 'fixture-ciphertext',
    iv: 'fixture-iv',
    authTag: 'fixture-authtag',
    aad: `${tenantId}:${channelConnectionId}`,
  });
  await db.insert(channelConnections).values({
    id: channelConnectionId,
    tenantId,
    brandId,
    providerKey: 'fixture_provider',
    remoteAccountId: `${label}-${channelConnectionId.slice(-8)}`,
    displayName: `Seeded ${label} channel`,
    credentialRefId,
    grantedScopes: [],
    missingScopes: [],
    status: 'active',
    tokenExpiresAt: null,
    capabilityVersion: 1,
  });
  const contentPackageId = newId('contentPackage');
  const contentRevisionId = newId('contentRevision');
  const copy = seedCopy(`Seeded ${label} caption`);
  await db.insert(contentPackages).values({
    id: contentPackageId,
    tenantId,
    brandId,
    briefId: null,
    title: `Seeded ${label} package`,
    currentRevisionId: contentRevisionId,
    state: 'draft',
    version: 1,
  });
  await db.insert(contentRevisions).values({
    id: contentRevisionId,
    tenantId,
    brandId,
    packageId: contentPackageId,
    number: 1,
    brandVersionId: tenant.brandVersionId,
    policyVersionId: tenant.policyVersionId,
    copy,
    creativeRevisionIds: [],
    factRefs: [],
    contentHash: hashCanonical({
      copy,
      creativeRevisionIds: [],
      factRefs: [],
      brandVersionId: tenant.brandVersionId,
      policyVersionId: tenant.policyVersionId,
    }),
    state: 'draft',
    authorKind: 'user',
    authorId: tenant.ownerUserId,
  });
  const channelVariantId = newId('channelVariant');
  await db.insert(channelVariants).values({
    id: channelVariantId,
    tenantId,
    brandId,
    contentRevisionId,
    channelConnectionId,
    text: copy.master.text,
    altTexts: [],
    settings: {},
    exportIds: [],
    capabilityVersion: 1,
    validation: { ok: true, issues: [] },
  });
  return { channelConnectionId, contentPackageId, contentRevisionId, channelVariantId };
}

/**
 * Per tenant, on brand 1: an active policy version (the brand seed's is a draft), a campaign, a brief, and a
 * package with revision 1 and one channel variant, so a foreign caller has every content id to try (spec 19.3).
 * The published brand version comes from CREATIVE_SEED; the revision only references its id.
 */
export const CONTENT_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const contentPolicyVersionId = newId('policyVersion');
  await db.insert(policyVersions).values({
    id: contentPolicyVersionId,
    tenantId,
    brandId,
    number: 2,
    document: defaultPolicyDocument(),
    state: 'active',
    createdByUserId: ownerUserId,
  });
  const campaignId = newId('campaign');
  await db.insert(campaigns).values({
    id: campaignId,
    tenantId,
    brandId,
    objectiveId: null,
    name: 'Seeded campaign',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: new Date('2026-12-31T00:00:00Z'),
    state: 'draft',
  });
  const briefId = newId('brief');
  await db.insert(briefs).values({
    id: briefId,
    tenantId,
    brandId,
    campaignId,
    audience: 'Seeded audience',
    message: 'Seeded message',
    offerFactIds: [],
    channelConnectionIds: [],
    constraints: [],
    state: 'draft',
    createdByKind: 'user',
    createdById: ownerUserId,
  });
  const pkg = await seedContentPackage(
    db,
    {
      tenantId,
      brandId,
      ownerUserId,
      brandVersionId: newId('brandVersion'),
      policyVersionId: contentPolicyVersionId,
    },
    'content',
  );
  return { contentPolicyVersionId, campaignId, briefId, ...pkg };
};
