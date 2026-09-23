import {
  double,
  foreignKey,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { PreRegistrationV1 } from '@oremedia/contracts/experiments';
import { brandId, createdAt, hash, id, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

export const experiments = mysqlTable(
  'experiments',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    recommendationId: ref('recommendation_id'),
    hypothesis: text('hypothesis').notNull(),
    mode: mysqlEnum('mode', ['randomised', 'structured_comparison']).notNull(),
    primaryMetricKey: varchar('primary_metric_key', { length: 80 }).notNull(),
    guardrailMetricKeys: json('guardrail_metric_keys').$type<string[]>().notNull(),
    allocationMethod: varchar('allocation_method', { length: 40 }).notNull(),
    minSample: json('min_sample').$type<{ perArm: number }>().notNull(),
    observationWindowHours: json('observation_window').$type<{ hours: number }>().notNull(),
    stoppingRule: json('stopping_rule').$type<Record<string, unknown>>().notNull(),
    preRegistration: json('pre_registration').$type<PreRegistrationV1>(),
    preRegistrationHash: hash('pre_registration_hash'),
    preRegisteredAt: ts('pre_registered_at'),
    state: mysqlEnum('state', ['designed', 'pre_registered', 'running', 'stopped', 'analysed'])
      .notNull()
      .default('designed'),
    startedAt: ts('started_at'),
    stoppedAt: ts('stopped_at'),
    createdByKind: mysqlEnum('created_by_kind', ['user', 'agent']).notNull(),
    createdById: ref('created_by_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_experiment_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_experiment_state').on(t.tenantId, t.brandId, t.state),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_experiment_brand',
    }),
  ],
);

export const experimentVariants = mysqlTable(
  'experiment_variants',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    experimentId: ref('experiment_id').notNull(),
    label: varchar('label', { length: 80 }).notNull(),
    contentRevisionId: ref('content_revision_id').notNull(),
    allocationWeight: double('allocation_weight').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('uq_experiment_variant_label').on(t.tenantId, t.experimentId, t.label),
    foreignKey({
      columns: [t.tenantId, t.brandId, t.experimentId],
      foreignColumns: [experiments.tenantId, experiments.brandId, experiments.id],
      name: 'fk_experiment_variant_experiment',
    }),
  ],
);

/** Insert-only. */
export const experimentAssignments = mysqlTable(
  'experiment_assignments',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    experimentId: ref('experiment_id').notNull(),
    unitType: mysqlEnum('unit_type', ['visitor', 'publication_slot']).notNull(),
    unitIdHash: varchar('unit_id_hash', { length: 64 }).notNull(),
    variantId: ref('variant_id').notNull(),
    assignedAt: ts('assigned_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_experiment_assignment').on(t.tenantId, t.experimentId, t.unitType, t.unitIdHash)],
);

/** Insert-only. */
export const experimentResults = mysqlTable(
  'experiment_results',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    experimentId: ref('experiment_id').notNull(),
    computedAt: ts('computed_at').notNull(),
    preRegistrationHash: hash('pre_registration_hash').notNull(),
    perVariant: json('per_variant')
      .$type<Record<string, { n: number; x: number; rate: number | null; exposure?: number }>>()
      .notNull(),
    estimate: double('estimate'),
    intervalLow: double('interval_low'),
    intervalHigh: double('interval_high'),
    pValue: double('p_value'),
    guardrailBreached: json('guardrail_breached').$type<string[]>().notNull(),
    verdict: mysqlEnum('verdict', ['supported', 'not_supported', 'inconclusive']).notNull(),
    verdictReason: varchar('verdict_reason', { length: 200 }).notNull(),
    methodVersion: varchar('method_version', { length: 40 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_experiment_result').on(t.tenantId, t.experimentId, t.computedAt)],
);
