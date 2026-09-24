import type { SeededTenant } from '../seed';

/**
 * Spec 19.3 "the same pattern runs for ... agent tools": one entry per Release 1 agent tool, every id argument
 * pointing at the *foreign* tenant's seeded rows. A registered tool without an entry fails CI. `buildArguments: null`
 * documents a tool that takes no resource ids (it acts on the run's own brand only). `dataOf` marks read tools whose
 * correct outcome for foreign filters is "no data": it returns whatever data the output carries (must be empty).
 */
export interface AgentToolFixture {
  buildArguments: ((foreign: SeededTenant['ids']) => Record<string, unknown>) | null;
  reason?: string;
  dataOf?: (output: unknown) => unknown[];
  /**
   * A known isolation gap owned by another module: the call is not rejected yet, but it must still write nothing in
   * the foreign tenant. The harness fails once the gap is fixed so the entry is removed.
   */
  knownGap?: string;
}

const RUN_BRAND_ONLY = 'takes no resource ids: it reads or writes the run’s own brand only';

export const AGENT_TOOL_INPUTS: Record<string, AgentToolFixture> = {
  'brand.getSnapshot': { buildArguments: null, reason: RUN_BRAND_ONLY },
  'assets.searchEligible': { buildArguments: null, reason: RUN_BRAND_ONLY },
  'facts.list': { buildArguments: null, reason: RUN_BRAND_ONLY },
  'voice.clusters': { buildArguments: null, reason: RUN_BRAND_ONLY },
  'images.generate': { buildArguments: null, reason: RUN_BRAND_ONLY },
  'recommendations.create': {
    buildArguments: null,
    reason: 'evidence refs are opaque strings recorded on a recommendation of the run’s brand',
  },
  'metrics.query': {
    buildArguments: (f) => ({
      metricKeys: ['impressions'],
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-12-31T00:00:00.000Z',
      channelConnectionIds: [f['publishingChannelConnectionId'], f['channelConnectionId']],
    }),
    dataOf: (output) => (output as { series: Array<{ points: unknown[] }> }).series.flatMap((s) => s.points),
  },
  'content.createBrief': {
    buildArguments: (f) => ({
      campaignId: f['campaignId'],
      audience: 'Foreign audience',
      message: 'Foreign message',
      offerFactIds: [f['factId']],
      channelConnectionIds: [f['channelConnectionId']],
    }),
  },
  'content.draftCopy': {
    buildArguments: (f) => ({
      briefId: f['briefId'],
      variants: [{ text: 'Foreign caption', factIds: [], rationale: 'foreign' }],
    }),
  },
  'creative.proposeOperations': {
    buildArguments: (f) => ({
      documentId: f['creativeDocumentId'],
      baseRevisionId: f['creativeRevisionId'],
      operations: [
        { op: 'setText', pageId: 'page_1', elementId: f['creativeElementId'], text: 'Foreign headline' },
      ],
      summary: 'foreign edit',
    }),
  },
  'creative.requestRender': {
    buildArguments: (f) => ({
      documentId: f['creativeDocumentId'],
      revisionId: f['creativeRevisionId'],
      formatKeys: ['square_1080'],
    }),
  },
  'review.runBrandReview': {
    buildArguments: (f) => ({ documentId: f['creativeDocumentId'], revisionId: f['creativeRevisionId'] }),
  },
  'review.request': {
    buildArguments: (f) => ({
      contentRevisionId: f['contentRevisionId'],
      timing: { kind: 'exact', at: '2030-01-01T09:00:00.000Z' },
    }),
  },
  'experiments.proposeDesign': {
    buildArguments: (f) => ({
      recommendationId: f['recommendationId'],
      hypothesis: 'Foreign hypothesis',
      primaryMetricKey: 'qualified_enquiries',
      variants: [
        { key: 'a', description: 'control' },
        { key: 'b', description: 'treatment' },
      ],
    }),
  },
  'publications.proposeSchedule': {
    buildArguments: (f) => ({
      contentRevisionId: f['reviewContentRevisionId'],
      channelConnectionIds: [f['publishingChannelConnectionId']],
      proposedAt: '2030-01-01T09:00:00.000Z',
    }),
  },
};
