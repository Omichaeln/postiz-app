import { ApprovalBindingV1 } from '@oremedia/contracts/approval';
import type { FrozenManifestV1 } from '@oremedia/contracts/review';
import { externalReviewerLinks } from '@oremedia/db/schema/access';
import { publishingMandates, releaseApprovals, reviewRequests } from '@oremedia/db/schema/review';
import { hashCanonical, hashText } from '@oremedia/domain/hash';
import { newId } from '@oremedia/domain/ids';
import { newOpaqueToken } from '@oremedia/module-access';
import type { SeedExtension } from '../cross-tenant-inputs';
import { seedContentPackage } from './content-seed';

/**
 * Per tenant, on brand 1: a package of its own with an open request (frozen manifest), a valid approval bound to
 * that manifest, an external reviewer link and an active mandate, so a foreign caller has every review id to try.
 * The policy version id is a reference only (CONTENT_SEED activates the brand's policy).
 */
export const REVIEW_SEED: SeedExtension = async (db, { tenantId, brandIds, ownerUserId }) => {
  const brandId = brandIds[0];
  const brandVersionId = newId('brandVersion');
  const policyVersionId = newId('policyVersion');
  const pkg = await seedContentPackage(
    db,
    { tenantId, brandId, ownerUserId, brandVersionId, policyVersionId },
    'review',
  );
  const timing = { kind: 'exact' as const, at: '2026-06-01T09:00:00.000Z' };
  const manifest: FrozenManifestV1 = {
    v: 1,
    contentRevisionId: pkg.contentRevisionId,
    contentHash: 'a'.repeat(64),
    creativeRevisionIds: [],
    exports: [],
    captions: [
      {
        channelConnectionId: pkg.channelConnectionId,
        text: 'Seeded review caption',
        altTexts: [],
        settingsHash: hashCanonical({}),
      },
    ],
    timing,
    brandVersionId,
    policyVersionId,
  };
  const reviewRequestId = newId('reviewRequest');
  await db.insert(reviewRequests).values({
    id: reviewRequestId,
    tenantId,
    brandId,
    contentRevisionId: pkg.contentRevisionId,
    frozenManifest: manifest,
    manifestHash: hashCanonical(manifest),
    assignees: [],
    dueAt: null,
    state: 'open',
    requestedByKind: 'user',
    requestedById: ownerUserId,
  });
  const binding = ApprovalBindingV1.parse({
    v: 1,
    tenantId,
    brandId,
    contentRevisionId: pkg.contentRevisionId,
    brandVersionId,
    policyVersionId,
    targets: [
      {
        channelConnectionId: pkg.channelConnectionId,
        textHash: hashText('Seeded review caption'),
        altTextHashes: [],
        settingsHash: hashCanonical({}),
        exportHashes: [],
      },
    ],
    timing,
  });
  const approvalId = newId('releaseApproval');
  await db.insert(releaseApprovals).values({
    id: approvalId,
    tenantId,
    brandId,
    contentRevisionId: pkg.contentRevisionId,
    reviewRequestId,
    approverKind: 'user',
    approverId: ownerUserId,
    bindingHash: hashCanonical(binding),
    binding,
    validUntil: null,
    state: 'valid',
  });
  const externalLinkId = newId('externalReviewerLink');
  await db.insert(externalReviewerLinks).values({
    id: externalLinkId,
    tenantId,
    brandId,
    reviewRequestId,
    tokenHash: newOpaqueToken('rl').hash,
    email: `reviewer-${externalLinkId.slice(-6).toLowerCase()}@example.test`,
    expiresAt: new Date(Date.now() + 3600_000),
    createdByUserId: ownerUserId,
  });
  const mandateId = newId('publishingMandate');
  await db.insert(publishingMandates).values({
    id: mandateId,
    tenantId,
    brandId,
    ownerUserId,
    servicePrincipalId: newId('servicePrincipal'),
    channelConnectionIds: [pkg.channelConnectionId],
    allowedContentClasses: ['general'],
    sourceRules: {
      onlyApprovedFacts: true,
      onlyApprovedTemplates: true,
      onlyApprovedAssets: true,
      requireBrandReviewClean: true,
    },
    maxPostsPerDay: 3,
    windowStart: new Date('2026-01-01T00:00:00Z'),
    windowEnd: new Date('2027-01-01T00:00:00Z'),
    state: 'active',
  });
  return {
    reviewRequestId,
    approvalId,
    externalLinkId,
    mandateId,
    reviewContentRevisionId: pkg.contentRevisionId,
    reviewChannelConnectionId: pkg.channelConnectionId,
  };
};
