import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import type { SkillManifestV1 } from '@oremedia/contracts/skills';
import { brandId, createdAt, hash, id, ref, ts, updatedAt, version } from './_columns';

/**
 * Global + tenant: platform-owned built-in skills have tenant_id NULL and scope 'platform'; tenant-authored skills
 * carry tenant_id. Listed in GLOBAL_TABLES; the repository scopes reads to (tenant_id = ctx OR scope = 'platform')
 * and requires tenant context for every write.
 */
export const skills = mysqlTable(
  'skills',
  {
    id: id(),
    tenantId: varchar('tenant_id', { length: 32 }),
    scope: mysqlEnum('scope', ['platform', 'tenant', 'brand']).notNull(),
    brandId: ref('brand_id'),
    key: varchar('key', { length: 80 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    ownerUserId: ref('owner_user_id'),
    activeVersionId: ref('active_version_id'),
    state: mysqlEnum('state', ['active', 'retired']).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [uniqueIndex('uq_skill_key').on(t.scope, t.tenantId, t.brandId, t.key)],
);

export const skillVersions = mysqlTable(
  'skill_versions',
  {
    id: id(),
    tenantId: varchar('tenant_id', { length: 32 }),
    skillId: ref('skill_id').notNull(),
    number: int('number').notNull(),
    manifest: json('manifest').$type<SkillManifestV1>().notNull(), // inputs, outputs, tools, budgets, models
    instructions: text('instructions').notNull(), // SKILL.md
    references: json('references').$type<Record<string, string>>().notNull(),
    packageHash: hash('package_hash').notNull(),
    state: mysqlEnum('state', ['draft', 'sandbox_evaluation', 'in_review', 'published', 'retired'])
      .notNull()
      .default('draft'),
    rolloutPercent: int('rollout_percent').notNull().default(0),
    publishedAt: ts('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_skill_version_number').on(t.skillId, t.number),
    index('ix_skill_version_state').on(t.skillId, t.state),
  ],
);

export const skillBindings = mysqlTable(
  'skill_bindings',
  {
    id: id(),
    tenantId: varchar('tenant_id', { length: 32 }).notNull(),
    brandId: brandId(),
    skillVersionId: ref('skill_version_id').notNull(),
    taskKind: varchar('task_kind', { length: 40 }).notNull(),
    priority: int('priority').notNull().default(100),
    createdAt: createdAt(),
    version: version(),
  },
  (t) => [
    uniqueIndex('uq_skill_binding').on(t.tenantId, t.brandId, t.taskKind, t.skillVersionId),
    index('ix_skill_binding_task').on(t.tenantId, t.brandId, t.taskKind, t.priority),
  ],
);

export const evaluationSuites = mysqlTable(
  'evaluation_suites',
  {
    id: id(),
    tenantId: varchar('tenant_id', { length: 32 }),
    skillVersionId: ref('skill_version_id').notNull(),
    cases: json('cases')
      .$type<Array<{ id: string; input: unknown; brandFixture: string; expected: Record<string, unknown> }>>()
      .notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_eval_suite_version').on(t.skillVersionId)],
);

/** Insert-only. */
export const evaluationResults = mysqlTable(
  'evaluation_results',
  {
    id: id(),
    tenantId: varchar('tenant_id', { length: 32 }),
    suiteId: ref('suite_id').notNull(),
    skillVersionId: ref('skill_version_id').notNull(),
    modelVersion: varchar('model_version', { length: 80 }).notNull(),
    runs: int('runs').notNull(),
    scores: json('scores').$type<Record<string, number>>().notNull(),
    variance: json('variance').$type<Record<string, number>>().notNull(),
    deterministicChecks: json('deterministic_checks').$type<Record<string, boolean>>().notNull(),
    passed: boolean('passed').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('ix_eval_result_version').on(t.skillVersionId, t.createdAt)],
);
