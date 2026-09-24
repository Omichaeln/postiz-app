import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';

/** Facebook Page via the Meta Graph API (spec 14.6, 14.8). Re-verified at certification; `certifiedAt` stays null until then. */
export const facebookPageCapability: ProviderCapabilityV1 = {
  key: 'facebook_page',
  version: 1,
  text: {
    maxLength: 63_206,
    weighted: false,
    supportsLinks: true,
    supportsMentions: true,
    supportsHashtags: true,
  },
  media: {
    image: {
      mimes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
      minWidth: 200,
      maxWidth: 8192,
      aspectRatios: [],
      maxBytes: 4 * 1024 * 1024, // "Photos should be smaller than 4 MB" (Graph error 1366046)
      maxCount: 10,
    },
    video: {
      mimes: ['video/mp4', 'video/quicktime'],
      maxDurationSec: 240 * 60,
      maxBytes: 1024 * 1024 * 1024,
    },
    carousel: { min: 2, max: 10 },
    altText: true, // alt_text_custom on /photos
    // Meta fetches photos synchronously and videos asynchronously from the public (signed) URL.
    publicUrlFetch: { required: true, processingWindowSec: 3600 },
  },
  threading: 'comments',
  asyncProcessing: true, // videos process after the post is created
  idempotencyKeySupported: false,
  reconciliation: 'by_recent_posts_scan', // /{page}/posts?since= matched by message fingerprint
  analytics: {
    post: [
      'post_total_media_view_unique',
      'post_clicks',
      'post_clicks_by_type',
      'post_reactions_by_type_total',
    ],
    account: [
      'page_total_media_view_unique',
      'page_media_view',
      'page_post_engagements',
      'page_daily_follows',
    ],
    latencyHours: 24,
  },
  comments: { read: true, reply: true },
  edit: true,
  delete: true,
  // Page-level: 4800 × engaged users per 24 h; app-level: 200 × users per hour. Both unverified until certification.
  rateLimits: [
    { scope: 'account', limit: 4800, windowSec: 86_400 },
    { scope: 'app', limit: 200, windowSec: 3600 },
  ],
  requiredScopes: [
    'pages_show_list',
    'pages_manage_posts',
    'pages_read_engagement',
    'pages_manage_engagement',
    'read_insights',
    'business_management',
  ],
  certifiedAt: null,
};
