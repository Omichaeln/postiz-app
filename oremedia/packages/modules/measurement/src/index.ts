// Measurement (spec 15, 16.2, 16.5 first half): metric definitions and raw snapshots with provenance and
// completeness, normalisation with freshness and coverage, the engagement quality composite, tracked links, creative
// attribute capture and read-only comment ingestion. The collection and ingestion runtimes run in worker-ingest.
export {
  definitionService,
  globalDefinitionsFor,
  derivedRateDefinitions,
  toDefinitionDto,
} from './definitions';
export { createMetricService, metricService } from './metrics';
export {
  comparableGroupFor,
  aggregationFor,
  deriveRates,
  freshnessOf,
  latestPerSubjectMetric,
  aggregateByComparableGroup,
  coverageOf,
  DERIVED_RATES,
  STALE_FACTOR,
  type RateInput,
  type DerivedRate,
} from './normalise';
export {
  engagementQuality,
  resolveWeights,
  DEFAULT_WEIGHTS,
  QUALITY_COMPONENTS,
  type QualityComponent,
  type QualityResult,
} from './quality';
export {
  linkService,
  rewriteLinks,
  extractUrls,
  utmFor,
  withUtm,
  newShortCode,
  SHORT_CODE_PATTERN,
  SHORT_CODE_LENGTH,
} from './links';
export { attributeService, copyFeatures, layoutFeatures } from './attributes';
export { createMetricCollectionRuntime, type MetricCollectionOptions } from './collection';
export { createCommentIngestionRuntime, authorHash } from './comments';
export { collectionPlan, sourceOf, providerKeyOfSource, DEFAULT_LATENCY_HOURS } from './common';
export {
  configureLinkTracking,
  linkTrackingFromEnv,
  linkTrackingOptions,
  configureAuthorHashing,
  authorHashingFromEnv,
  registerCommentSink,
  registerCommentClassifier,
  resetCommentSinks,
  registerBrandChecker as registerMeasurementBrandChecker,
  type BrandChecker as MeasurementBrandChecker,
  type CommentSink,
  type CommentClassifier,
  type IngestedComment,
  type LinkTrackingOptions,
} from './hooks';
export {
  registerMeasurementOutboxRoutes,
  metricCollectionWorkflowId,
  commentIngestionWorkflowId,
  INGEST_METRICS_TASK_QUEUE,
  INGEST_COMMENTS_TASK_QUEUE,
  METRIC_COLLECTION_WORKFLOW_TYPE,
  COMMENT_INGESTION_WORKFLOW_TYPE,
} from './outbox-routes';
export {
  MetricDefinitionRepository,
  MetricSnapshotRepository,
  TrackedLinkRepository,
  LinkClickRepository,
  ConversationRepository,
  MessageRepository,
} from './repositories';
