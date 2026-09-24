import {
  channelConnections,
  credentialRefs,
  publicationAttempts,
  publications,
} from '@oremedia/db/schema/publishing';
import { hashCanonical } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import type { SeedExtension } from '../cross-tenant-inputs';

/**
 * Per tenant, on brand 1: an active fixture channel with a placeholder credential row, one scheduled publication
 * with an open attempt, so a foreign caller has every publishing id to try (spec 19.3 publishing.*). The
 * placeholders are not a real envelope (VARBINARY columns travel as base64 text); nothing here decrypts.
 */
export const PUBLISHING_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const publishingCredentialRefId = newId('credentialRef');
  const publishingChannelConnectionId = newId('channelConnection');
  const publicationId = newId('publication');
  const publicationAttemptId = newId('publicationAttempt');
  await db.insert(credentialRefs).values({
    id: publishingCredentialRefId,
    tenantId,
    kmsKeyId: 'fixture-kms-key',
    wrappedDataKey: 'Zml4dHVyZQ==',
    ciphertext: 'Zml4dHVyZQ==',
    iv: 'Zml4dHVyZQ==',
    authTag: 'Zml4dHVyZQ==',
    aad: `${tenantId}:${publishingChannelConnectionId}`,
  });
  await db.insert(channelConnections).values({
    id: publishingChannelConnectionId,
    tenantId,
    brandId,
    providerKey: 'fixture_provider',
    remoteAccountId: `pub-${publishingChannelConnectionId.slice(-8)}`,
    displayName: 'Seeded publishing channel',
    credentialRefId: publishingCredentialRefId,
    grantedScopes: ['w_post'],
    missingScopes: [],
    status: 'active',
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    capabilityVersion: 1,
  });
  await db.insert(publications).values({
    id: publicationId,
    tenantId,
    brandId,
    contentPackageId: newId('contentPackage'),
    contentRevisionId: newId('contentRevision'),
    channelVariantId: newId('channelVariant'),
    channelConnectionId: publishingChannelConnectionId,
    occurrenceKey: `seed:${publicationId}`,
    authority: 'approval',
    approvalId: newId('releaseApproval'),
    mandateId: null,
    scheduledFor: new Date(Date.now() + 3600_000),
    state: 'scheduled',
    claimant: `pub:${publicationId}`,
    scheduledByKind: 'user',
    scheduledById: ownerUserId,
  });
  await db.insert(publicationAttempts).values({
    id: publicationAttemptId,
    tenantId,
    publicationId,
    attemptNumber: 1,
    fencingToken: 1,
    requestFingerprint: hashCanonical({ seed: publicationId }),
    providerIdempotencyKey: publicationAttemptId,
    startedAt: new Date(),
    outcome: 'unknown',
  });
  return { publishingCredentialRefId, publishingChannelConnectionId, publicationId, publicationAttemptId };
};
