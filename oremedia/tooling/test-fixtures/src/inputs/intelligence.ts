import type { CrossTenantFixture } from '../cross-tenant-inputs';

/** One entry per intelligence.* procedure, every id pointing at the foreign tenant's rows from INTELLIGENCE_SEED (spec 19.3). */
export const INTELLIGENCE_INPUTS: Record<string, CrossTenantFixture> = {
  'intelligence.insights.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'intelligence.recommendations.list': {
    buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }),
  },
  'intelligence.recommendations.get': { buildInput: (f) => ({ recommendationId: f['recommendationId'] }) },
  'intelligence.recommendations.accept': {
    buildInput: (f) => ({
      recommendationId: f['recommendationId'],
      expectedVersion: 0,
      action: 'create_brief',
      brief: { audience: 'foreign', message: 'foreign' },
    }),
  },
  'intelligence.recommendations.dismiss': {
    buildInput: (f) => ({ recommendationId: f['recommendationId'], expectedVersion: 0, reason: 'x' }),
  },
  'intelligence.playbook.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'intelligence.playbook.propose': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      practice: 'foreign practice',
      evidenceInsightIds: [f['insightId']],
      strength: 'observed',
      reviewAfter: '2030-01-01T00:00:00.000Z',
    }),
  },
  'intelligence.playbook.approve': {
    buildInput: (f) => ({ playbookEntryId: f['playbookEntryId'], expectedVersion: 0 }),
  },
  'intelligence.voice.clusters': { buildInput: (f) => ({ brandId: f['brandId'], limit: 20 }) },
  'intelligence.anomalies.list': { buildInput: (f) => ({ brandId: f['brandId'], page: { limit: 50 } }) },
  'intelligence.workspace.get': { buildInput: (f) => ({ brandId: f['brandId'] }) },
  'intelligence.analyst.run': {
    buildInput: (f) => ({
      brandId: f['brandId'],
      servicePrincipalId: f['servicePrincipalId'],
      periodDays: 7,
    }),
  },
};
