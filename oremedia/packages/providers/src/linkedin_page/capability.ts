import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';

/**
 * LinkedIn Page (organisation) via the versioned Community Management API (spec 14.6, 14.8).
 * Values derived from current LinkedIn documentation knowledge; every entry marked in
 * docs/runbooks/certify-a-channel.md is re-verified during certification. `certifiedAt` stays null until then.
 */
export const linkedInPageCapability: ProviderCapabilityV1 = {
  key: 'linkedin_page',
  version: 1,
  text: {
    maxLength: 3000,
    weighted: false,
    supportsLinks: true,
    supportsMentions: true,
    supportsHashtags: true,
  },
  media: {
    image: {
      mimes: ['image/jpeg', 'image/png', 'image/gif'],
      minWidth: 200,
      maxWidth: 7680,
      aspectRatios: [], // LinkedIn crops the feed preview rather than rejecting a ratio
      maxBytes: 8 * 1024 * 1024,
      maxCount: 20, // multi-image posts
    },
    video: { mimes: ['video/mp4'], maxDurationSec: 30 * 60, maxBytes: 200 * 1024 * 1024 }, // Oremedia cap; LinkedIn allows more
    carousel: { min: 2, max: 20 },
    altText: true,
    // Bytes are uploaded to LinkedIn's upload URL; no public fetch, no external processing window for the URL.
    publicUrlFetch: { required: false, processingWindowSec: 0 },
  },
  threading: 'comments',
  asyncProcessing: true, // images and videos are processed after upload and must be AVAILABLE before the post
  idempotencyKeySupported: false,
  reconciliation: 'by_recent_posts_scan', // Posts API: find posts by author, matched by commentary fingerprint
  analytics: {
    post: [
      'impressionCount',
      'uniqueImpressionsCount',
      'clickCount',
      'likeCount',
      'commentCount',
      'shareCount',
      'engagement',
    ],
    account: [
      'followerGains.organicFollowerGain',
      'followerGains.paidFollowerGain',
      'totalPageStatistics.views.allPageViews.pageViews',
      'totalShareStatistics.impressionCount',
      'totalShareStatistics.clickCount',
      'totalShareStatistics.engagement',
    ],
    latencyHours: 24,
  },
  comments: { read: true, reply: true },
  edit: true, // PARTIAL_UPDATE of commentary on /rest/posts
  delete: true,
  // Request-level throttles (the limiter runs per request). LinkedIn's documented daily creation cap for
  // /rest/posts per member (150) is enforced by the platform; both values below are unverified until certification.
  rateLimits: [
    { scope: 'account', limit: 500, windowSec: 86_400 },
    { scope: 'app', limit: 100_000, windowSec: 86_400 },
  ],
  requiredScopes: [
    'openid',
    'profile',
    'w_organization_social',
    'r_organization_social',
    'rw_organization_admin',
  ],
  certifiedAt: null,
};
