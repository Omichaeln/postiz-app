import type { CrossTenantFixture } from '../cross-tenant-inputs';
import { seedCopy } from './content-seed';

/** One entry per content.* procedure, every id pointing at the foreign tenant's rows from CONTENT_SEED (spec 19.3). */
export const CONTENT_INPUTS: Record<string, CrossTenantFixture> = {
  'content.campaigns.create': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      name: 'Foreign campaign',
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-02-01T00:00:00.000Z',
    }),
  },
  'content.campaigns.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'content.campaigns.get': { buildInput: (f) => ({ campaignId: f['campaignId'] }) },
  'content.briefs.create': {
    buildInput: (f) => ({ brandId: f['brandId'], audience: 'x', message: 'x', campaignId: f['campaignId'] }),
  },
  'content.briefs.accept': { buildInput: (f) => ({ briefId: f['briefId'], expectedVersion: 0 }) },
  'content.briefs.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'content.briefs.get': { buildInput: (f) => ({ briefId: f['briefId'] }) },
  'content.packages.create': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      briefId: f['briefId'],
      title: 'Foreign package',
      copy: seedCopy(),
    }),
  },
  'content.packages.revise': {
    buildInput: (f) => ({
      contentPackageId: f['contentPackageId'],
      expectedVersion: 1,
      copy: seedCopy('changed'),
    }),
  },
  'content.packages.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'content.packages.get': { buildInput: (f) => ({ contentPackageId: f['contentPackageId'] }) },
  'content.revisions.get': { buildInput: (f) => ({ revisionId: f['contentRevisionId'] }) },
  'content.variants.generate': {
    buildInput: (f) => ({
      contentRevisionId: f['contentRevisionId'],
      channelConnectionIds: [f['channelConnectionId']],
    }),
  },
  'content.variants.update': {
    buildInput: (f) => ({
      channelVariantId: f['channelVariantId'],
      expectedVersion: 0,
      text: 'changed',
      altTexts: [],
      settings: {},
      exportIds: [],
    }),
  },
  'content.variants.get': { buildInput: (f) => ({ variantId: f['channelVariantId'] }) },
  'content.calendar.range': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-12-31T00:00:00.000Z',
    }),
  },
};
