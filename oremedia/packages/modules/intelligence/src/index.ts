// Intelligence (spec 16): insights and recommendations from the brand analyst, recommendation actions with
// back-references, the customer voice library, learning records with the monthly baseline comparison, the playbook
// and the per-brand workspace. Experiments live in @oremedia/module-experiments and are reached through hooks.
export {
  intelligenceService,
  configureRanking,
  ACTION_FOR_SUGGESTION,
  BASELINE_COMPARISON_EVIDENCE,
} from './service';
export {
  createIntelligenceRuntime,
  movementsOf,
  statementFor,
  ANOMALY_THRESHOLD,
  CHANGE_THRESHOLD,
  type IntelligenceRuntimeOptions,
  type MetricMovement,
} from './analyst';
export { intelligenceToolSource, PROPOSED_DESIGN_DEFAULTS } from './tools';
export {
  registerMetricsSource,
  resetMetricsSource,
  MetricsSourceUnregisteredError,
  registerExperimentDesigner,
  resetExperimentDesigner,
  registerExperimentSource,
  registerPublicationVolumeSource,
  registerAnalystTargetSource,
  resetAnalystTargetSource,
  type MetricsSource,
  type MetricsWindowQuery,
  type ExperimentDesigner,
  type ExperimentSource,
  type ExperimentSummary,
  type PublicationVolumeSource,
  type AnalystTargetSource,
} from './hooks';
export {
  registerIntelligenceOutboxRoutes,
  brandAnalystWorkflowId,
  CORE_TASK_QUEUE,
  BRAND_ANALYST_WORKFLOW_TYPE,
  ANALYST_SWEEP_WORKFLOW_TYPE,
  BASELINE_COMPARISON_WORKFLOW_TYPE,
  ANALYST_SCHEDULE_ID,
  BASELINE_COMPARISON_SCHEDULE_ID,
} from './outbox-routes';
export {
  rankBaseline,
  rankLearned,
  applyExploration,
  scoreRanking,
  compareRankings,
  rankingConfigFromEnv,
  DEFAULT_RANKING_CONFIG,
  type Rankable,
  type RankingObjective,
  type OutcomeHistory,
  type RankingConfig,
  type BaselineComparison,
} from './ranking';
export {
  configureVoiceClassifier,
  classifierConfigFromEnv,
  classifyComment,
  parseClassification,
  registerEmbedder,
  HashingEmbedder,
  nearestCluster,
  cosine,
  DEFAULT_CLASSIFIER_MODEL_ID,
  CLUSTER_SIMILARITY_THRESHOLD,
  type Embedder,
  type VoiceClassifierConfig,
} from './voice';
export {
  InsightRepository,
  RecommendationRepository,
  LearningRecordRepository,
  PlaybookEntryRepository,
  CustomerVoiceClusterRepository,
  AnomalyRepository,
} from './repositories';
