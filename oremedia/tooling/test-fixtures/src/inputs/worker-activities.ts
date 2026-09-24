import type { SeededTenant } from '../seed';

/**
 * Spec 19.3 / 5.2 for background work (ledger S.1): one entry per Temporal activity a worker registers, keyed
 * `<task queue>.<activity name>` (a `publish-<providerKey>` queue is keyed `publish-<provider>`: every provider queue
 * registers the same activities). `buildInput` gets the caller's activity context (tenant A: tenantId, actor,
 * correlationId) and returns the activity input with every resource id pointing at the *foreign* tenant's seeded
 * rows; an activity whose only id is the brand acts in the foreign brand, any other acts in the caller's own brand.
 * `buildInput: null` documents an activity that takes no tenant-scoped id (a platform sweeper that iterates tenants
 * by design), with the reason. `noOp` marks an activity whose correct outcome for foreign ids may be an idempotent
 * no-op instead of a refusal: it returns the foreign data the result carries (must be empty). A registered activity
 * without an entry, or an entry for an activity no worker registers, fails the harness
 * (apps/worker-*\/src/activities.cross-tenant.test.ts).
 */
export interface ActivityContext {
  tenantId: string;
  actor: { kind: 'user' | 'service_principal' | 'platform_operator'; id: string };
  correlationId: string;
}

type Ids = SeededTenant['ids'];

export interface WorkerActivityFixture {
  buildInput: ((ctx: ActivityContext, foreign: Ids, own: Ids) => unknown) | null;
  reason?: string;
  noOp?: (result: unknown) => unknown[];
  /** Who the workflow runs as: the tenant owner (default) or the tenant's own service principal (analyst runs). */
  actor?: 'owner' | 'service_principal';
}

export type WorkerName = 'worker-core' | 'worker-ingest' | 'worker-render';

const PLATFORM_SWEEP =
  'platform-level: carries no tenant (only a correlation id and a clock); it iterates tenants by design and each ' +
  'item it finds is handled by a tenant-scoped activity listed here';
const PERIOD = { periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-02-01T00:00:00.000Z' };
const BUDGET = { maxSteps: 5, maxTokens: 1000, maxCostMicros: 1000, maxVariants: 1, deadlineSeconds: 60 };

const run = (ctx: ActivityContext, f: Ids, own: Ids) => ({
  ...ctx,
  runId: f['agentRunId'],
  brandId: own['brandId'],
});
const skillEvaluation = (ctx: ActivityContext, f: Ids) => ({
  ...ctx,
  skillVersionId: f['skillVersionId'],
  skillId: f['skillId'],
  suiteId: f['evaluationSuiteId'],
  runs: 3,
});
const publication = (ctx: ActivityContext, f: Ids) => ({ ...ctx, publicationId: f['publicationId'] });
const attempt = (ctx: ActivityContext, f: Ids, outcome: string) => ({
  ...publication(ctx, f),
  attempt: { attemptId: f['publicationAttemptId'], outcome, remotePostId: 'foreign-remote-post' },
});
const providerCall = (ctx: ActivityContext, f: Ids) => ({
  ...publication(ctx, f),
  fencingToken: 1,
  attemptId: f['publicationAttemptId'],
});
const analyst = (ctx: ActivityContext, f: Ids, own: Ids) => ({
  ...ctx,
  brandId: own['brandId'],
  servicePrincipalId: f['servicePrincipalId'],
  ...PERIOD,
});
const deletion = (ctx: ActivityContext, f: Ids) => ({ ...ctx, deletionRequestId: f['deletionRequestId'] });
const exportOf = (f: Ids) => ({
  pageId: 'page_1',
  formatKey: 'square_1080',
  storageKey: `assets/${f['tenantId']}/${f['brandId']}/exports/${f['creativeRevisionId']}/${f['renderJobId']}/page_1-square_1080.png`,
  contentHash: 'a'.repeat(64),
  bytes: 1,
  width: 1080,
  height: 1080,
  mime: 'image/png',
  findings: [],
});
const renderJob = (ctx: ActivityContext, f: Ids) => ({ ...ctx, renderJobId: f['renderJobId'] });
const renderTarget = (ctx: ActivityContext, f: Ids, own: Ids) => ({
  ...renderJob(ctx, f),
  revisionId: f['creativeRevisionId'],
  documentId: f['creativeDocumentId'],
  brandId: own['brandId'],
});
const ingest = (ctx: ActivityContext, f: Ids, own: Ids) => ({
  ...ctx,
  intentId: f['uploadIntentId'],
  brandId: own['brandId'],
});
const quarantineKey = (f: Ids) => `quarantine/${f['tenantId']}/${f['uploadIntentId']}/original`;
const collectionPlan = (ctx: ActivityContext, f: Ids) => publication(ctx, f);
/** Brand change impact finds nothing of a foreign brand in the caller's tenant: every list and count is empty. */
const BRAND_CHANGE_NO_OP =
  'the brand change runs in the caller tenant, where the foreign brand has no approvals or publications';
const touched = (result: unknown): unknown[] => {
  const r = result as Record<string, unknown>;
  return Object.values(r).flatMap((v) => (Array.isArray(v) ? v : typeof v === 'number' && v > 0 ? [v] : []));
};

export const WORKER_ACTIVITY_INPUTS: Record<WorkerName, Record<string, WorkerActivityFixture>> = {
  'worker-core': {
    // ---- task queue `agents`: agentRunWorkflowV1 (spec 12.2) and skillEvaluationWorkflowV1 (spec 10.2) ----
    'agents.resolveContextSnapshot': { buildInput: run },
    'agents.reserveBudget': { buildInput: (ctx, f, own) => ({ ...run(ctx, f, own), budget: BUDGET }) },
    'agents.planNextStep': { buildInput: (ctx, f, own) => ({ ...run(ctx, f, own), step: 1 }) },
    'agents.dispatchTool': {
      buildInput: (ctx, f, own) => ({
        ...run(ctx, f, own),
        step: 1,
        stepId: f['agentStepId'],
        call: { id: 'toolu_harness', name: 'brand.getSnapshot', arguments: {} },
      }),
    },
    'agents.recordDecision': {
      buildInput: (ctx, f, own) => ({
        ...run(ctx, f, own),
        decision: { stepId: f['agentStepId'], decision: 'reject' },
      }),
    },
    'agents.finishRun': { buildInput: (ctx, f, own) => ({ ...run(ctx, f, own), state: 'cancelled' }) },
    'agents.settleBudget': { buildInput: run },
    'agents.runSkillEvaluation': { buildInput: skillEvaluation },
    'agents.failSkillEvaluation': {
      buildInput: (ctx, f) => ({ ...skillEvaluation(ctx, f), error: 'harness failure' }),
    },

    // ---- task queue `core`: publicationWorkflowV1 control activities (spec 14.3) ----
    'core.readSchedule': { buildInput: publication },
    'core.cancelIfNotStarted': { buildInput: publication },
    'core.claimForDispatch': { buildInput: (ctx, f) => ({ ...publication(ctx, f), claimant: 'harness' }) },
    'core.evaluateRelease': { buildInput: (ctx, f) => ({ ...publication(ctx, f), fencingToken: 1 }) },
    'core.hold': { buildInput: (ctx, f) => ({ ...publication(ctx, f), reasons: ['harness'] }) },
    'core.releaseClaimAndCancel': { buildInput: (ctx, f) => ({ ...publication(ctx, f), fencingToken: 1 }) },
    'core.openAttempt': { buildInput: (ctx, f) => ({ ...publication(ctx, f), fencingToken: 1 }) },
    'core.markProcessing': { buildInput: (ctx, f) => attempt(ctx, f, 'pending') },
    'core.markPublished': { buildInput: (ctx, f) => attempt(ctx, f, 'accepted') },
    'core.markFailed': { buildInput: (ctx, f) => attempt(ctx, f, 'rejected') },
    'core.markOutcomeUnknown': {
      buildInput: (ctx, f) => ({ ...publication(ctx, f), attemptId: f['publicationAttemptId'] }),
    },
    'core.markRetryEligible': { buildInput: publication },
    'core.holdForHuman': { buildInput: (ctx, f) => ({ ...publication(ctx, f), reason: 'harness' }) },
    'core.retryAfterProvenNoEffect': { buildInput: (ctx, f) => attempt(ctx, f, 'retryable_error') },
    // tokenRefreshWorkflowV1 (spec 14.7)
    'core.readRefreshSchedule': {
      buildInput: (ctx, f) => ({ ...ctx, channelConnectionId: f['publishingChannelConnectionId'] }),
    },
    'core.refreshCredentials': {
      buildInput: (ctx, f) => ({ ...ctx, channelConnectionId: f['publishingChannelConnectionId'] }),
    },
    'core.sweepPublications': { buildInput: null, reason: PLATFORM_SWEEP },
    // brandChangeImpactWorkflowV1 (spec 8.2): the brand is the only id, so it acts in the foreign brand
    'core.invalidateApprovals': {
      reason: BRAND_CHANGE_NO_OP,
      noOp: touched,
      buildInput: (ctx, f) => ({
        ...ctx,
        brandId: f['brandId'],
        change: { kind: 'version_published', brandVersionId: f['creativePublishedBrandVersionId'] },
      }),
    },
    'core.reevaluateScheduledPublications': {
      reason: BRAND_CHANGE_NO_OP,
      noOp: touched,
      buildInput: (ctx, f) => ({
        ...ctx,
        brandId: f['brandId'],
        change: { kind: 'version_published', brandVersionId: f['creativePublishedBrandVersionId'] },
      }),
    },
    'core.applyFactRevocation': {
      reason: BRAND_CHANGE_NO_OP,
      noOp: touched,
      buildInput: (ctx, f, own) => ({
        ...ctx,
        brandId: own['brandId'],
        change: { kind: 'fact_revoked', factId: f['factId'] },
        factId: f['factId'],
      }),
    },
    // brandAnalystWorkflowV1 / baselineComparisonWorkflowV1 (spec 16.3, 16.8)
    'core.prepareAnalysis': {
      actor: 'service_principal',
      buildInput: (ctx, f) => ({
        ...ctx,
        brandId: f['brandId'],
        servicePrincipalId: f['servicePrincipalId'],
        ...PERIOD,
      }),
    },
    'core.readAnalystRun': {
      actor: 'service_principal',
      buildInput: (ctx, f, own) => ({ ...analyst(ctx, f, own), runId: f['agentRunId'] }),
    },
    'core.recordAnalystOutcome': {
      actor: 'service_principal',
      buildInput: (ctx, f, own) => ({
        ...analyst(ctx, f, own),
        runId: f['agentRunId'],
        runState: 'completed',
        changeInsightIds: [f['insightId']],
      }),
    },
    'core.listAnalystTargets': { buildInput: null, reason: PLATFORM_SWEEP },
    'core.listBaselineTargets': { buildInput: null, reason: PLATFORM_SWEEP },
    'core.compareRankingBaseline': {
      actor: 'service_principal',
      buildInput: (ctx, f) => ({ ...ctx, brandId: f['brandId'], ...PERIOD }),
    },
    // deletionRequestWorkflowV1 / retentionSweepWorkflowV1 (spec 17.5)
    'core.beginDeletion': { buildInput: deletion },
    'core.runDeletionHandler': { buildInput: (ctx, f) => ({ ...deletion(ctx, f), handler: 'assets' }) },
    'core.finishDeletion': { buildInput: deletion },
    'core.listRetentionTenants': { buildInput: null, reason: PLATFORM_SWEEP },
    'core.applyRetention': {
      buildInput: null,
      reason:
        'its only id is the tenant it runs in: input.tenantId is the tenant context itself (a platform job applied ' +
        'inside one tenant under RETENTION_ACTOR), so there is no foreign resource id to carry',
    },

    // ---- task queue `publish-<providerKey>`: provider activities (spec 14.3) ----
    'publish-<provider>.publishOnce': { buildInput: providerCall },
    'publish-<provider>.checkStatus': { buildInput: providerCall },
    'publish-<provider>.finalize': { buildInput: providerCall },
    'publish-<provider>.findRemotePost': {
      buildInput: (ctx, f) => ({ ...publication(ctx, f), attemptId: f['publicationAttemptId'] }),
    },
  },

  'worker-ingest': {
    // metricCollectionWorkflowV1 (spec 15.1) and commentIngestionWorkflowV1 (spec 16.5)
    'ingest-metrics.readCollectionPlan': { buildInput: collectionPlan },
    'ingest-metrics.pullMetrics': {
      buildInput: (ctx, f) => ({
        ...publication(ctx, f),
        pullIndex: 0,
        windowStart: '2026-01-01T00:00:00.000Z',
        windowEnd: '2026-01-02T00:00:00.000Z',
      }),
    },
    'ingest-comments.readCollectionPlan': { buildInput: collectionPlan },
    'ingest-comments.pullComments': {
      buildInput: (ctx, f) => ({ ...publication(ctx, f), pullIndex: 0, since: null, cursor: null }),
    },
  },

  'worker-render': {
    // ---- task queue `render`: renderJobWorkflowV1 (spec 11.5) ----
    'render.beginRender': { buildInput: renderJob },
    'render.resolveRenderInputs': {
      buildInput: (ctx, f, own) => ({ ...renderTarget(ctx, f, own), formatKeys: ['square_1080'] }),
    },
    'render.renderFormat': {
      buildInput: (ctx, f, own) => ({
        ...renderTarget(ctx, f, own),
        brandVersionId: f['creativePublishedBrandVersionId'],
        target: { pageId: 'page_1', formatKey: 'square_1080', reflow: false },
        fonts: [],
        assets: [],
        rendererVersion: 'harness',
      }),
    },
    'render.storeExport': {
      buildInput: (ctx, f, own) => ({ ...renderJob(ctx, f), brandId: own['brandId'], export: exportOf(f) }),
    },
    'render.completeRender': {
      buildInput: (ctx, f) => ({
        ...renderJob(ctx, f),
        rendererVersion: 'harness',
        manifest: {
          rendererVersion: 'harness',
          fonts: [],
          assets: [],
          brandVersionId: f['creativePublishedBrandVersionId'],
          revisionContentHash: 'a'.repeat(64),
        },
        exports: [exportOf(f)],
      }),
    },
    'render.failRender': { buildInput: (ctx, f) => ({ ...renderJob(ctx, f), reason: 'render_failed' }) },

    // ---- task queue `media`: assetIngestWorkflowV1 (spec 9.1) ----
    'media.beginIngest': { buildInput: ingest },
    'media.verifyUpload': { buildInput: ingest },
    'media.sniffUpload': { buildInput: ingest },
    'media.scanUpload': { buildInput: ingest },
    'media.sanitiseUpload': {
      buildInput: (ctx, f, own) => ({ ...ingest(ctx, f, own), mime: 'image/png', group: 'image' }),
    },
    'media.hashUpload': {
      buildInput: (ctx, f, own) => ({ ...ingest(ctx, f, own), sanitisedKey: quarantineKey(f) }),
    },
    'media.buildDerivatives': {
      buildInput: (ctx, f, own) => ({
        ...ingest(ctx, f, own),
        sanitisedKey: quarantineKey(f),
        mime: 'image/png',
        group: 'image',
      }),
    },
    'media.moveToImmutable': {
      buildInput: (ctx, f, own) => ({
        ...ingest(ctx, f, own),
        sanitisedKey: quarantineKey(f),
        derivatives: [],
      }),
    },
    'media.catalogueAsset': {
      buildInput: (ctx, f, own) => ({
        ...ingest(ctx, f, own),
        assetId: f['pendingAssetId'],
        assetVersionId: f['assetVersionId'],
        originalKey: `assets/${f['tenantId']}/${f['brandId']}/originals/${f['assetVersionId']}`,
        contentHash: 'b'.repeat(64),
        mime: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
        colourProfile: null,
        sanitised: true,
        derivatives: [],
      }),
    },
    'media.finaliseUpload': {
      buildInput: (ctx, f, own) => ({
        ...ingest(ctx, f, own),
        outcome: 'rejected',
        reason: 'type_unrecognised',
        cleanupKeys: [quarantineKey(f)],
      }),
    },
  },
};
