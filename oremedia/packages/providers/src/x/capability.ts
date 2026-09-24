import type { ProviderCapabilityV1 } from '@oremedia/contracts/providers';
import { X_MAX_WEIGHTED_LENGTH } from './text';

/**
 * X (API v2, OAuth 2.0 with PKCE). Built as the fourth Release 1 channel; decision D-04 (X or TikTok) is still open.
 * Tier-dependent values (rate limits, non-public metrics, search) are unverified until certification.
 */
export const xCapability: ProviderCapabilityV1 = {
  key: 'x',
  version: 1,
  text: {
    maxLength: X_MAX_WEIGHTED_LENGTH,
    weighted: true,
    supportsLinks: true,
    supportsMentions: true,
    supportsHashtags: true,
  },
  media: {
    image: {
      mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
      minWidth: 4,
      maxWidth: 8192,
      aspectRatios: [],
      maxBytes: 5 * 1024 * 1024, // GIFs may be 15 MB: adapter-specific check
      maxCount: 4,
    },
    video: { mimes: ['video/mp4', 'video/quicktime'], maxDurationSec: 140, maxBytes: 512 * 1024 * 1024 },
    carousel: { min: 2, max: 4 },
    altText: true, // POST /2/media/metadata
    publicUrlFetch: { required: false, processingWindowSec: 0 }, // bytes are uploaded in chunks
  },
  threading: 'thread',
  asyncProcessing: true, // video transcoding (STATUS polling) before the post
  idempotencyKeySupported: false, // duplicate-content rejection is the only platform-side guard
  reconciliation: 'by_recent_posts_scan', // GET /2/users/:id/tweets?start_time= matched by text fingerprint
  analytics: {
    post: [
      'impression_count',
      'like_count',
      'reply_count',
      'retweet_count',
      'quote_count',
      'bookmark_count',
      'url_link_clicks',
      'user_profile_clicks',
      'engagements',
    ],
    account: ['followers_count', 'following_count', 'tweet_count', 'listed_count'],
    latencyHours: 1,
  },
  comments: { read: true, reply: true }, // replies via search/recent conversation_id (Basic tier or above)
  edit: false,
  delete: true,
  rateLimits: [
    { scope: 'account', limit: 100, windowSec: 900 },
    { scope: 'app', limit: 10_000, windowSec: 86_400 },
  ],
  requiredScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access', 'media.write'],
  certifiedAt: null,
};
