import {
  double,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { brandId, createdAt, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

export const insights = mysqlTable(
  'insights',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: mysqlEnum('kind', ['change', 'anomaly', 'association', 'experimental_finding']).notNull(),
    statement: text('statement').notNull(),
    evidence: json('evidence').$type<Array<{ kind: string; ref: string; note?: string }>>().notNull(),
    strength: mysqlEnum('strength', ['observed', 'directional', 'experimentally_supported']).notNull(),
    periodStart: ts('period_start').notNull(),
    periodEnd: ts('period_end').notNull(),
    state: mysqlEnum('state', ['active', 'superseded', 'dismissed']).notNull().default('active'),
    agentRunId: ref('agent_run_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_insight_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_insight_period').on(t.tenantId, t.brandId, t.periodEnd),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_insight_brand',
    }),
  ],
);

export const recommendations = mysqlTable(
  'recommendations',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    insightIds: json('insight_ids').$type<string[]>().notNull(),
    proposedAction: mysqlEnum('proposed_action', [
      'create_brief',
      'generate_variants',
      'open_canvas',
      'prepare_test',
      'assign_response',
      'propose_playbook_update',
    ]).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    rationale: text('rationale').notNull(),
    expectedBenefit: json('expected_benefit')
      .$type<{ metricKey: string; direction: 'up' | 'down'; magnitude?: string }>()
      .notNull(),
    effort: mysqlEnum('effort', ['low', 'medium', 'high']).notNull(),
    uncertainty: mysqlEnum('uncertainty', ['low', 'medium', 'high']).notNull(),
    rank: int('rank').notNull().default(0),
    rankingPolicy: varchar('ranking_policy', { length: 40 }).notNull().default('baseline'),
    state: mysqlEnum('state', ['proposed', 'accepted', 'dismissed', 'executed'])
      .notNull()
      .default('proposed'),
    dismissalReason: varchar('dismissal_reason', { length: 500 }),
    decidedByUserId: ref('decided_by_user_id'),
    downstreamType: varchar('downstream_type', { length: 40 }),
    downstreamId: ref('downstream_id'),
    agentRunId: ref('agent_run_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_recommendation_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_recommendation_state').on(t.tenantId, t.brandId, t.state, t.rank),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_recommendation_brand',
    }),
  ],
);

export const learningRecords = mysqlTable(
  'learning_records',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    recommendationId: ref('recommendation_id').notNull(),
    contextRef: varchar('context_ref', { length: 200 }).notNull(),
    evidenceRef: varchar('evidence_ref', { length: 200 }).notNull(),
    hypothesis: text('hypothesis').notNull(),
    action: varchar('action', { length: 40 }).notNull(),
    humanDecision: mysqlEnum('human_decision', ['accepted', 'modified', 'rejected', 'pending'])
      .notNull()
      .default('pending'),
    executedRevisionId: ref('executed_revision_id'),
    observedOutcomeRef: varchar('observed_outcome_ref', { length: 200 }),
    verdict: mysqlEnum('verdict', ['supported', 'not_supported', 'inconclusive', 'pending'])
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_learning_record_recommendation').on(t.tenantId, t.recommendationId),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_learning_brand',
    }),
  ],
);

export const playbookEntries = mysqlTable(
  'playbook_entries',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    practice: text('practice').notNull(),
    evidenceIds: json('evidence_ids').$type<string[]>().notNull(),
    strength: mysqlEnum('strength', ['observed', 'directional', 'experimentally_supported']).notNull(),
    approvedByUserId: ref('approved_by_user_id'),
    reviewAfter: ts('review_after').notNull(),
    state: mysqlEnum('state', ['proposed', 'approved', 'retired']).notNull().default('proposed'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('ix_playbook_state').on(t.tenantId, t.brandId, t.state),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_playbook_brand',
    }),
  ],
);

export const customerVoiceClusters = mysqlTable(
  'customer_voice_clusters',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    label: varchar('label', { length: 200 }).notNull(),
    kind: mysqlEnum('kind', ['question', 'objection', 'praise', 'need', 'complaint']).notNull(),
    size: int('size').notNull().default(0),
    sampleMessageRefs: json('sample_message_refs').$type<string[]>().notNull(),
    centroid: json('centroid').$type<number[]>(),
    linkedRecommendationIds: json('linked_recommendation_ids').$type<string[]>().notNull().default([]),
    firstSeen: ts('first_seen').notNull(),
    lastSeen: ts('last_seen').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('ix_voice_cluster_brand').on(t.tenantId, t.brandId, t.kind, t.size),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_voice_cluster_brand',
    }),
  ],
);

export const listeningSources = mysqlTable(
  'listening_sources',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    kind: mysqlEnum('kind', ['keyword', 'competitor_account', 'rss', 'subreddit']).notNull(),
    config: json('config').$type<Record<string, unknown>>().notNull(),
    coverage: json('coverage').$type<{
      sources: string[];
      competitors: string[];
      languages: string[];
      periodStart: string;
      periodEnd: string;
    }>(),
    state: mysqlEnum('state', ['active', 'paused']).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_listening_brand',
    }),
  ],
);

export const anomalies = mysqlTable(
  'anomalies',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    signal: varchar('signal', { length: 120 }).notNull(),
    baseline: double('baseline').notNull(),
    observed: double('observed').notNull(),
    severity: mysqlEnum('severity', ['low', 'medium', 'high']).notNull(),
    detectedAt: ts('detected_at').notNull(),
    state: mysqlEnum('state', ['open', 'acknowledged', 'resolved']).notNull().default('open'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('ix_anomaly_state').on(t.tenantId, t.brandId, t.state, t.detectedAt),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_anomaly_brand',
    }),
  ],
);
