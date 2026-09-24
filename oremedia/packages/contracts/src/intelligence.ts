import { z } from 'zod';

export const InsightKind = z.enum(['change', 'anomaly', 'association', 'experimental_finding']);
export const EvidenceStrength = z.enum(['observed', 'directional', 'experimentally_supported']);
export type EvidenceStrength = z.infer<typeof EvidenceStrength>;
export const InsightState = z.enum(['active', 'superseded', 'dismissed']);

export const RecommendationAction = z.enum([
  'create_brief',
  'generate_variants',
  'open_canvas',
  'prepare_test',
  'assign_response',
  'propose_playbook_update',
]);
export type RecommendationAction = z.infer<typeof RecommendationAction>;
export const RecommendationState = z.enum(['proposed', 'accepted', 'dismissed', 'executed']);

export const LearningVerdict = z.enum(['supported', 'not_supported', 'inconclusive', 'pending']);
export const PlaybookState = z.enum(['proposed', 'approved', 'retired']);
export const VoiceClusterKind = z.enum(['question', 'objection', 'praise', 'need', 'complaint']);
export const MessageClassification = z.enum([
  'question',
  'objection',
  'praise',
  'need',
  'complaint',
  'spam',
  'other',
]);
export const ListeningSourceKind = z.enum(['keyword', 'competitor_account', 'rss', 'subreddit']);
export const AnomalyState = z.enum(['open', 'acknowledged', 'resolved']);

export const RecommendationDecide = z.object({
  recommendationId: z.string(),
  expectedVersion: z.number().int(),
  action: z.union([RecommendationAction, z.literal('dismiss')]),
  dismissalReason: z.string().max(500).optional(),
});

export const PlaybookPropose = z.object({
  brandId: z.string(),
  practice: z.string().min(1).max(2000),
  evidenceInsightIds: z.array(z.string()).min(1).max(50),
  strength: EvidenceStrength,
  reviewAfter: z.string().datetime(),
});

/** Spec 16.1: coverage statement always shown next to listening outputs. */
export const CoverageStatement = z.object({
  sources: z.array(z.string()),
  competitors: z.array(z.string()),
  languages: z.array(z.string()),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});

// ---------------------------------------------------------------------------------------------------------------
// Phase 6 intelligence module (spec 16.1, 16.3-16.5, 16.8, 16.9). Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';

export const InsightList = z.object({
  brandId: z.string(),
  kind: InsightKind.optional(),
  state: InsightState.default('active'),
  page: PageRequest,
});
export const RecommendationList = z.object({
  brandId: z.string(),
  state: RecommendationState.optional(),
  page: PageRequest,
});
/**
 * Spec 16.4: accepting creates the downstream object with a back-reference. The action must be one the
 * recommendation offers (its proposed action); `brief` and `experiment` carry what the downstream needs.
 */
export const RecommendationAccept = z.object({
  recommendationId: z.string(),
  expectedVersion: z.number().int(),
  action: RecommendationAction,
  brief: z
    .object({
      campaignId: z.string().optional(),
      audience: z.string().max(1000),
      message: z.string().max(2000),
      offerFactIds: z.array(z.string()).max(20).default([]),
      channelConnectionIds: z.array(z.string()).max(20).default([]),
    })
    .optional(),
  /** generate_variants: the service principal the copywriting run acts as. */
  servicePrincipalId: z.string().optional(),
  /** prepare_test: the pre-registration draft (experiments module validates it). */
  experimentDesign: z.record(z.unknown()).optional(),
  /** propose_playbook_update: the practice text proposed for the playbook (approval is separate). */
  playbook: z
    .object({ practice: z.string().min(1).max(2000), reviewAfter: z.string().datetime() })
    .optional(),
});
export const RecommendationDismiss = z.object({
  recommendationId: z.string(),
  expectedVersion: z.number().int(),
  reason: z.string().min(1).max(500),
});
export const RecommendationGet = z.object({ recommendationId: z.string() });
export const PlaybookList = z.object({
  brandId: z.string(),
  state: PlaybookState.optional(),
  page: PageRequest,
});
export const PlaybookApprove = z.object({ playbookEntryId: z.string(), expectedVersion: z.number().int() });
export const VoiceClustersList = z.object({
  brandId: z.string(),
  kind: VoiceClusterKind.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const WorkspaceGet = z.object({ brandId: z.string() });
export const AnalystRun = z.object({
  brandId: z.string(),
  servicePrincipalId: z.string(),
  /** Review window in days ending now (default 7: the weekly cadence). */
  periodDays: z.number().int().min(1).max(90).default(7),
});
export const AnomalyList = z.object({
  brandId: z.string(),
  state: AnomalyState.optional(),
  page: PageRequest,
});

/** Spec 16.5: one comment as the measurement side hands it to the voice library (never a raw author identity). */
export const VoiceCommentInput = z.object({
  brandId: z.string(),
  messageId: z.string(),
  text: z.string().min(1).max(20000),
  /** Salted per tenant by ingestion. */
  authorHash: z.string().max(64),
  remoteCreatedAt: z.string().datetime(),
  /** Already classified upstream, else the voice library classifies it. */
  classification: MessageClassification.optional(),
});
export type VoiceCommentInput = z.infer<typeof VoiceCommentInput>;

/** Spec 16.8 ranking policies; a setting selects the ranker and the monthly comparison can force the baseline. */
export const RankingPolicy = z.enum(['baseline', 'learned', 'exploration']);
export type RankingPolicy = z.infer<typeof RankingPolicy>;

export interface FreshnessStatement {
  /** ISO time of the newest input behind the view, or null when there is none. */
  asOf: string | null;
  ageHours: number | null;
  stale: boolean;
}

// ---- brandAnalystWorkflowV1 (task queue `core`, workflow id `brand-analyst:<brandId>:<periodEnd>`) ----

export const BrandAnalystWorkflowInputV1 = TenantContextInput.extend({
  brandId: z.string(),
  /** The service principal the performance-review run acts as (also the workflow's actor). */
  servicePrincipalId: z.string(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
});
export type BrandAnalystWorkflowInputV1 = z.infer<typeof BrandAnalystWorkflowInputV1>;

/** prepareAnalysis: deterministic "what changed" insights are written and the performance-review run starts. */
export interface PrepareAnalysisResultV1 {
  runId: string | null;
  /** null when the run could not start (flag off, no objective, no metrics source): the reason says why. */
  skippedReason: string | null;
  changeInsightIds: string[];
  coverage: z.infer<typeof CoverageStatement>;
}
export type ReadAnalystRunInputV1 = BrandAnalystWorkflowInputV1 & { runId: string };
export interface ReadAnalystRunResultV1 {
  state: string;
  terminal: boolean;
}
export type RecordAnalystOutcomeInputV1 = BrandAnalystWorkflowInputV1 & {
  runId: string | null;
  runState: string;
  changeInsightIds: string[];
};
export interface RecordAnalystOutcomeResultV1 {
  insights: number;
  recommendations: number;
  rankingPolicy: RankingPolicy;
}
export interface BrandAnalystActivitiesV1 {
  prepareAnalysis(input: BrandAnalystWorkflowInputV1): Promise<PrepareAnalysisResultV1>;
  readAnalystRun(input: ReadAnalystRunInputV1): Promise<ReadAnalystRunResultV1>;
  recordAnalystOutcome(input: RecordAnalystOutcomeInputV1): Promise<RecordAnalystOutcomeResultV1>;
}
export type BrandAnalystRuntimeV1 = BrandAnalystActivitiesV1;

/**
 * The weekly sweep (a Temporal schedule) lists every active brand with an analyst principal, then starts one run
 * each. A schedule starts the workflow with fixed args, so the workflow fills `now` and `correlationId` from its
 * own deterministic clock and run id when they are absent.
 */
export const AnalystSweepInputV1 = z.object({ correlationId: z.string(), now: z.string().datetime() });
export const AnalystSweepScheduleArgsV1 = AnalystSweepInputV1.partial();
export type AnalystSweepScheduleArgsV1 = z.infer<typeof AnalystSweepScheduleArgsV1>;
export type AnalystSweepInputV1 = z.infer<typeof AnalystSweepInputV1>;
export interface AnalystTargetV1 {
  tenantId: string;
  brandId: string;
  servicePrincipalId: string;
}
export interface AnalystSweepActivitiesV1 {
  listAnalystTargets(input: AnalystSweepInputV1): Promise<AnalystTargetV1[]>;
}
export type AnalystSweepRuntimeV1 = AnalystSweepActivitiesV1;

// ---- baselineComparisonWorkflowV1 (monthly, task queue `core`) ----

export const BaselineComparisonInputV1 = z.object({ correlationId: z.string(), now: z.string().datetime() });
export const BaselineComparisonScheduleArgsV1 = BaselineComparisonInputV1.partial();
export type BaselineComparisonScheduleArgsV1 = z.infer<typeof BaselineComparisonScheduleArgsV1>;
export type BaselineComparisonInputV1 = z.infer<typeof BaselineComparisonInputV1>;
export type CompareRankingInputV1 = TenantContextInput & {
  brandId: string;
  periodStart: string;
  periodEnd: string;
};
export interface CompareRankingResultV1 {
  brandId: string;
  /** Recommendations decided in the period with an observed outcome. */
  evaluated: number;
  learnedScore: number | null;
  baselineScore: number | null;
  margin: number;
  beaten: boolean;
  selected: RankingPolicy;
  insightId: string | null;
}
export interface BaselineComparisonActivitiesV1 {
  listBaselineTargets(input: BaselineComparisonInputV1): Promise<AnalystTargetV1[]>;
  compareRankingBaseline(input: CompareRankingInputV1): Promise<CompareRankingResultV1>;
}
export type BaselineComparisonRuntimeV1 = BaselineComparisonActivitiesV1;
