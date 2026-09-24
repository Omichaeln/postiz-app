import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** One entry per publishing.* procedure, every id pointing at the foreign tenant's rows from PUBLISHING_SEED (spec 19.3). */
export const PUBLISHING_INPUTS: Record<string, CrossTenantFixture> = {
  'publishing.channels.connect.start': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      providerKey: 'fixture_provider',
      redirectUri: 'https://app.example/oauth/callback',
    }),
  },
  'publishing.channels.connect.complete': {
    buildInput: () => ({ state: 'foreign-or-unknown-state', code: 'x' }),
    reason:
      'the PKCE state is server-side and tenant-bound; an unknown or foreign state is VALIDATION_FAILED',
  },
  'publishing.channels.list': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'publishing.channels.disconnect': {
    buildInput: (f) => ({ channelConnectionId: f['publishingChannelConnectionId'], expectedVersion: 0 }),
  },
  'publishing.publications.schedule': {
    buildInput: (f) => ({
      channelVariantId: f['channelVariantId'],
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      authority: 'approval',
      approvalId: f['approvalId'] ?? 'apr_foreign',
    }),
  },
  'publishing.publications.cancel': {
    buildInput: (f) => ({ publicationId: f['publicationId'], expectedVersion: 0 }),
  },
  'publishing.publications.reschedule': {
    buildInput: (f) => ({
      publicationId: f['publicationId'],
      expectedVersion: 0,
      scheduledFor: new Date(Date.now() + 7200_000).toISOString(),
    }),
  },
  'publishing.publications.get': { buildInput: (f) => ({ publicationId: f['publicationId'] }) },
  'publishing.publications.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'publishing.publications.evidence': { buildInput: (f) => ({ publicationId: f['publicationId'] }) },
  'publishing.publications.reconcile': {
    buildInput: (f) => ({ publicationId: f['publicationId'], resolution: 'confirm_absent' }),
  },
  'publishing.publications.deleteRemote': {
    buildInput: (f) => ({ publicationId: f['publicationId'], reason: 'x' }),
  },
};
