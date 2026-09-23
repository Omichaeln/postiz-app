import {
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { brandId, createdAt, hash, id, micros, ref, tenantId, ts, updatedAt, version } from './_columns';
import { brands } from './brand';

export const agentRuns = mysqlTable(
  'agent_runs',
  {
    id: id(),
    tenantId: tenantId(),
    brandId: brandId(),
    initiatorKind: mysqlEnum('initiator_kind', ['user', 'system', 'recommendation']).notNull(),
    initiatorId: ref('initiator_id').notNull(),
    servicePrincipalId: ref('service_principal_id').notNull(),
    autonomyMode: mysqlEnum('autonomy_mode', [
      'assist',
      'create',
      'prepare_release',
      'managed_autopublish',
    ]).notNull(),
    taskKind: varchar('task_kind', { length: 40 }).notNull(),
    brief: json('brief').$type<Record<string, unknown>>().notNull(),
    contextSnapshotHash: hash('context_snapshot_hash'),
    skillVersionIds: json('skill_version_ids').$type<string[]>().notNull(),
    modelConfig: json('model_config').$type<Record<string, string>>().notNull(),
    state: mysqlEnum('state', [
      'planned',
      'running',
      'waiting_for_review',
      'completed',
      'failed',
      'cancelled',
      'budget_exhausted',
      'policy_denied',
      'waiting_expired',
    ]).notNull(),
    budgetReservationId: ref('budget_reservation_id'),
    costMicros: micros('cost_micros').notNull().default(0),
    deadlineAt: ts('deadline_at').notNull(),
    workflowId: varchar('workflow_id', { length: 120 }),
    correlationId: varchar('correlation_id', { length: 64 }).notNull(),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_agent_run_tbi').on(t.tenantId, t.brandId, t.id),
    index('ix_agent_run_state').on(t.tenantId, t.brandId, t.state, t.createdAt),
    foreignKey({
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'fk_agent_run_brand',
    }),
  ],
);

/** Insert-only. */
export const agentSteps = mysqlTable(
  'agent_steps',
  {
    id: id(),
    tenantId: tenantId(),
    runId: ref('run_id').notNull(),
    index: int('index').notNull(),
    kind: mysqlEnum('kind', ['plan', 'model_call', 'tool_call', 'validation']).notNull(),
    summary: varchar('summary', { length: 1000 }).notNull(),
    tokensIn: int('tokens_in').notNull().default(0),
    tokensOut: int('tokens_out').notNull().default(0),
    costMicros: micros('cost_micros').notNull().default(0),
    durationMs: int('duration_ms').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_agent_step').on(t.tenantId, t.runId, t.index)],
);

/** Insert-only. */
export const toolInvocations = mysqlTable(
  'tool_invocations',
  {
    id: id(),
    tenantId: tenantId(),
    runId: ref('run_id').notNull(),
    stepId: ref('step_id').notNull(),
    toolName: varchar('tool_name', { length: 80 }).notNull(),
    inputHash: hash('input_hash').notNull(),
    inputRedacted: json('input_redacted').$type<Record<string, unknown>>().notNull(),
    policyDecision: mysqlEnum('policy_decision', ['allowed', 'denied', 'invalid']).notNull(),
    policyReason: varchar('policy_reason', { length: 80 }),
    outcome: mysqlEnum('outcome', ['ok', 'error', 'denied', 'invalid', 'proposal']).notNull(),
    outputRef: varchar('output_ref', { length: 200 }),
    createdAt: createdAt(),
  },
  (t) => [index('ix_tool_invocation_run').on(t.tenantId, t.runId, t.createdAt)],
);
