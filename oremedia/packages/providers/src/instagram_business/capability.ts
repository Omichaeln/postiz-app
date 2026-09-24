import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';

/** Instagram professional account via the Meta Graph API with Facebook Login (spec 14.6, 14.8). Uncertified. */
export const instagramBusinessCapability: ProviderCapabilityV1 = {
  key: 'instagram_business',
  version: 1,
  text: {
    maxLength: 2200,
    weighted: false,
    supportsLinks: true,
    supportsMentions: true,
    supportsHashtags: true,
  },
  media: {
    image: {
      mimes: ['image/jpeg'], // the container API accepts JPEG only
      minWidth: 320,
      maxWidth: 1440,
      aspectRatios: [{ min: 0.8, max: 1.91 }], // 4:5 to 1.91:1
      maxBytes: 8 * 1024 * 1024,
      maxCount: 10,
    },
    video: { mimes: ['video/mp4', 'video/quicktime'], maxDurationSec: 15 * 60, maxBytes: 1024 * 1024 * 1024 }, // Reels
    carousel: { min: 2, max: 10 },
    altText: true, // alt_text on the media container (unverified until certification)
    // Instagram fetches media from the public URL; containers expire 24 hours after creation.
    publicUrlFetch: { required: true, processingWindowSec: 86_400 },
  },
  threading: 'comments',
  asyncProcessing: true, // container status polling before media_publish
  idempotencyKeySupported: false,
  reconciliation: 'by_recent_posts_scan', // /{ig-user-id}/media?since= matched by caption fingerprint
  analytics: {
    post: ['views', 'reach', 'saved', 'likes', 'comments', 'shares', 'total_interactions'],
    account: [
      'follower_count',
      'reach',
      'views',
      'likes',
      'comments',
      'shares',
      'saves',
      'total_interactions',
    ],
    latencyHours: 24,
  },
  comments: { read: true, reply: true },
  edit: false,
  delete: false,
  // Request-level Graph API throttle per user; the platform also caps API-published posts at 25 per 24 h
  // (GET /{ig-user-id}/content_publishing_limit), which the runbook covers. Unverified until certification.
  rateLimits: [
    { scope: 'account', limit: 200, windowSec: 3600 },
    { scope: 'app', limit: 4800, windowSec: 3600 },
  ],
  requiredScopes: [
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',
    'instagram_manage_insights',
    'pages_show_list',
    'pages_read_engagement',
    'business_management',
  ],
  certifiedAt: null,
};
