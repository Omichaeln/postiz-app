import type { SeededTenant } from '../seed';

/**
 * Spec 19.3 for the MCP surface: one entry per exposed tool (apps/api/src/mcp/tools.ts MCP_TOOLS). `buildArguments`
 * gets the foreign tenant's ids and the caller's own; a tool whose only id is the brand acts in the foreign brand,
 * any other tool acts in the caller's brand with every resource id foreign. `null` = the tool takes no ids.
 */
export interface McpCrossTenantFixture {
  buildArguments:
    ((foreign: SeededTenant['ids'], own: SeededTenant['ids']) => Record<string, unknown>) | null;
  reason?: string;
}

export const MCP_CROSS_TENANT_INPUTS: Record<string, McpCrossTenantFixture> = {
  'brands.list': {
    buildArguments: null,
    reason: 'takes no ids; the harness checks it lists only the caller tenant brands',
  },
  'assets.searchEligible': { buildArguments: (f) => ({ brandId: f['brandId'], purpose: 'creative' }) },
  'content.createBrief': {
    buildArguments: (f, own) => ({
      brandId: own['brandId'],
      campaignId: f['campaignId'],
      title: 'Foreign',
      objective: 'x',
      factIds: [f['factId']],
    }),
  },
  'agents.startRun': {
    buildArguments: (f) => ({ brandId: f['brandId'], taskKind: 'copywriting', brief: { objective: 'x' } }),
  },
  'creative.proposeOperations': {
    buildArguments: (f, own) => ({
      brandId: own['brandId'],
      documentId: f['creativeDocumentId'],
      baseRevisionId: f['creativeRevisionId'],
      operations: [{ op: 'setLock', pageId: 'page_1', elementId: f['creativeElementId'], locked: true }],
      summary: 'x',
    }),
  },
  'review.request': {
    buildArguments: (f, own) => ({ brandId: own['brandId'], contentRevisionId: f['contentRevisionId'] }),
  },
  'publications.get': {
    buildArguments: (f, own) => ({ brandId: own['brandId'], publicationId: f['publicationId'] }),
  },
  'insights.list': { buildArguments: (f) => ({ brandId: f['brandId'] }) },
};
