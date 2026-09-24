import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** One entry per review.* procedure, every id pointing at the foreign tenant's rows from REVIEW_SEED (spec 19.3). */
export const REVIEW_INPUTS: Record<string, CrossTenantFixture> = {
  'review.requests.create': {
    buildInput: (f) => ({
      contentRevisionId: f['contentRevisionId'],
      timing: { kind: 'exact', at: '2026-06-01T09:00:00.000Z' },
    }),
  },
  'review.requests.get': { buildInput: (f) => ({ reviewRequestId: f['reviewRequestId'] }) },
  'review.decisions.submit': {
    buildInput: (f) => ({
      reviewRequestId: f['reviewRequestId'],
      decision: 'approve',
      expectedManifestHash: 'a'.repeat(64),
    }),
  },
  'review.inbox.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'review.externalLinks.create': {
    buildInput: (f) => ({
      reviewRequestId: f['reviewRequestId'],
      email: 'foreign@example.test',
      expiresAt: '2030-01-01T00:00:00.000Z',
    }),
  },
  'review.externalLinks.revoke': { buildInput: (f) => ({ linkId: f['externalLinkId'] }) },
  'review.approvals.get': { buildInput: (f) => ({ approvalId: f['approvalId'] }) },
  'review.mandates.create': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      servicePrincipalId: f['servicePrincipalId'],
      channelConnectionIds: [f['reviewChannelConnectionId']],
      allowedContentClasses: ['general'],
      sourceRules: {},
      maxPostsPerDay: 1,
      windowStart: '2026-01-01T00:00:00.000Z',
      windowEnd: '2030-01-01T00:00:00.000Z',
    }),
  },
  'review.mandates.pause': { buildInput: (f) => ({ mandateId: f['mandateId'], expectedVersion: 0 }) },
  'review.mandates.revoke': { buildInput: (f) => ({ mandateId: f['mandateId'], expectedVersion: 0 }) },
  'review.mandates.get': { buildInput: (f) => ({ mandateId: f['mandateId'] }) },
};
