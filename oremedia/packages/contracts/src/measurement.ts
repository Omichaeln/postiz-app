import { z } from 'zod';

export const Completeness = z.enum(['complete', 'partial', 'unavailable']);
export type Completeness = z.infer<typeof Completeness>;

export const MetricSubjectType = z.enum(['publication', 'channel', 'campaign', 'link']);

export const MetricDefinitionInput = z.object({
  key: z.string().max(80),
  providerKey: z.string().max(40).nullable(),
  nativeName: z.string().max(120),
  unit: z.string().max(40),
  aggregation: z.enum(['sum', 'max', 'last', 'avg', 'series']),
  comparableGroup: z.string().max(40),
  definitionVersion: z.number().int().min(1),
  separatesPaidOrganic: z.boolean().default(false),
});

export const MetricsQuery = z.object({
  brandId: z.string(),
  subjectType: MetricSubjectType,
  subjectIds: z.array(z.string()).min(1).max(200),
  metricKeys: z.array(z.string()).min(1).max(50),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
});

export const TrackedLinkCreate = z.object({
  brandId: z.string(),
  publicationId: z.string().optional(),
  variantId: z.string().optional(),
  experimentId: z.string().optional(),
  destination: z.string().url().max(2000),
  utm: z.record(z.string().max(200)).default({}),
});

export const ConversionSource = z.enum(['crm', 'pixel', 'form']);

// ---------------------------------------------------------------------------------------------------------------
// Phase 6 measurement module (spec 15, 16.2, 16.5 first half). Appended only; nothing above changes.
// ---------------------------------------------------------------------------------------------------------------
import { PageRequest } from './pagination';
import { TenantContextInput } from './tenancy';
import { CreativeAttributesV1 } from './content';

export const MetricAggregation = z.enum(['sum', 'max', 'last', 'avg', 'series']);
export type MetricAggregation = z.infer<typeof MetricAggregation>;

export const MetricDefinitionList = z.object({
  /** Restrict to one provider's native definitions; omitted lists global and tenant definitions. */
  providerKey: z.string().max(40).optional(),
});
export const MetricDefinitionGet = z.object({ definitionId: z.string() });
/** Tenant-defined metrics carry the caller's tenant; global rows are seeded from the capability register. */
export const MetricDefinitionCreate = MetricDefinitionInput.extend({
  definition: z.string().max(1000).optional(),
});

export const MetricGrouping = z.enum(['subject', 'metric', 'comparable_group']);
export type MetricGrouping = z.infer<typeof MetricGrouping>;
/** Spec 15.2 query: brand, range, metric keys, grouping; every value carries freshness and completeness. */
export const MetricsQueryV1 = MetricsQuery.extend({ grouping: MetricGrouping.default('subject') });
export type MetricsQueryV1 = z.infer<typeof MetricsQueryV1>;

export const EngagementQualityGet = z.object({
  brandId: z.string(),
  publicationId: z.string(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
});

export const TrackedLinkList = z.object({
  brandId: z.string(),
  publicationId: z.string().optional(),
  variantId: z.string().optional(),
  page: PageRequest,
});

export const CreativeAttributesGet = z.object({
  contentRevisionId: z.string().optional(),
  channelVariantId: z.string().optional(),
  attributeId: z.string().optional(),
});
/** Humans may correct any attribute; the row then records source = human_corrected (spec 16.2). */
export const CreativeAttributesCorrect = z.object({
  attributeId: z.string(),
  expectedVersion: z.number().int(),
  attributes: CreativeAttributesV1.partial(),
});

/** Every number is shown next to its freshness (spec 15.2): stale when older than latency × 2. */
export interface MetricFreshness {
  fetchedAt: string;
  ageHours: number;
  latencyHours: number;
  stale: boolean;
}

export interface MetricValueV1 {
  snapshotId: string;
  subjectType: z.infer<typeof MetricSubjectType>;
  subjectId: string;
  metricKey: string;
  comparableGroup: string;
  value: number | null;
  series: Array<{ at: string; value: number }> | null;
  completeness: Completeness;
  freshness: MetricFreshness;
  source: string;
  definitionVersion: number;
  windowStart: string;
  windowEnd: string;
  brandTimezone: string;
  numeratorSnapshotId: string | null;
  denominatorSnapshotId: string | null;
}

/** An aggregate over one comparable_group only (spec 15.2); nothing is summed across groups. */
export interface MetricAggregateV1 {
  comparableGroup: string;
  metricKeys: string[];
  value: number | null;
  snapshotIds: string[];
  subjectsWithData: number;
  subjectsUnavailable: number;
  freshness: MetricFreshness | null;
  stale: boolean;
}

/** A coverage statement travels with every query result: what was asked, what was available, what is stale. */
export interface MetricCoverageV1 {
  subjectsRequested: number;
  subjectsWithData: number;
  metricsRequested: string[];
  metricsWithData: string[];
  metricsUnavailable: string[];
  staleValues: number;
  windowStart: string;
  windowEnd: string;
}

// ---- workflow contracts (metricCollectionWorkflowV1 on `ingest-metrics`, commentIngestionWorkflowV1 on `ingest-comments`) ----

export const MetricCollectionWorkflowInputV1 = TenantContextInput.extend({ publicationId: z.string() });
export type MetricCollectionWorkflowInputV1 = z.infer<typeof MetricCollectionWorkflowInputV1>;

/** What the schedule is derived from: the publication moment and the capability's analytics latency (spec 15.1). */
export interface CollectionPlanV1 {
  /** A publication that is not (or no longer) published has nothing to collect. */
  collectable: boolean;
  providerKey: string;
  publishedAt: string | null;
  latencyHours: number;
  commentsReadable: boolean;
}

export type PullMetricsInputV1 = MetricCollectionWorkflowInputV1 & {
  /** Pull number in the schedule (0-based), so the activity is idempotent per (publication, metric, window). */
  pullIndex: number;
  windowStart: string;
  windowEnd: string;
};

export interface PullMetricsResultV1 {
  /** Rows written by this call; a repeat of an already-written window writes nothing. */
  written: number;
  skipped: number;
  unavailable: number;
}

export interface MetricCollectionActivitiesV1 {
  readCollectionPlan(input: MetricCollectionWorkflowInputV1): Promise<CollectionPlanV1>;
  pullMetrics(input: PullMetricsInputV1): Promise<PullMetricsResultV1>;
}

export const CommentIngestionWorkflowInputV1 = TenantContextInput.extend({ publicationId: z.string() });
export type CommentIngestionWorkflowInputV1 = z.infer<typeof CommentIngestionWorkflowInputV1>;

export type PullCommentsInputV1 = CommentIngestionWorkflowInputV1 & {
  pullIndex: number;
  since: string | null;
  cursor: string | null;
};

export interface PullCommentsResultV1 {
  ingested: number;
  duplicates: number;
  nextCursor: string | null;
}

export interface CommentIngestionActivitiesV1 {
  readCollectionPlan(input: CommentIngestionWorkflowInputV1): Promise<CollectionPlanV1>;
  pullComments(input: PullCommentsInputV1): Promise<PullCommentsResultV1>;
}

/** The module-side implementations the activities wrap (tenant context is established by the activity host). */
export interface MetricCollectionRuntimeV1 {
  readCollectionPlan(input: MetricCollectionWorkflowInputV1): Promise<CollectionPlanV1>;
  pullMetrics(
    input: PullMetricsInputV1,
    hooks?: { heartbeat(detail: string): void },
  ): Promise<PullMetricsResultV1>;
}
export interface CommentIngestionRuntimeV1 {
  readCollectionPlan(input: CommentIngestionWorkflowInputV1): Promise<CollectionPlanV1>;
  pullComments(
    input: PullCommentsInputV1,
    hooks?: { heartbeat(detail: string): void },
  ): Promise<PullCommentsResultV1>;
}
