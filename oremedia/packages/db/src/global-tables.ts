/**
 * Spec 5.4 (3): every table in packages/db/src/schema either has a `tenant_id` column or is listed here with a
 * written justification. `tooling/scripts/check-schema-tenancy.ts` enforces this in CI.
 */
export const GLOBAL_TABLES: Readonly<Record<string, string>> = {
  users: 'Identities span tenants; a user reaches tenant data only through memberships (spec 5.1).',
  tenants: 'The tenant row itself; the id is the tenant key.',
  sessions:
    'Belongs to a user; the selected tenant is a hint verified against memberships on every request (spec 7.1).',
  provider_capabilities: 'Platform-wide capability register (spec 14.6); contains no tenant content.',
  plans: 'Commercial catalogue shared by all tenants (spec 22.1); contains no tenant content.',
  feature_flags:
    'Engineering flags with tenant targeting inside the row (spec 22.1); contains no tenant content.',
};

/**
 * Tables whose tenant_id is nullable because they hold both global (platform) rows and tenant rows. Repositories
 * for these scope reads to `(tenant_id = ctx OR tenant_id IS NULL)` and require tenant context for every write.
 */
export const GLOBAL_PLUS_TENANT_TABLES: Readonly<Record<string, string>> = {
  metric_definitions: 'Global definitions have NULL tenant_id; tenant overrides carry tenant_id (spec 6.3).',
  skills:
    'Platform built-in skills have NULL tenant_id and scope platform; tenant/brand skills carry tenant_id (spec 10).',
  skill_versions: 'Follows skills.',
  evaluation_suites: 'Follows skill_versions.',
  evaluation_results: 'Follows skill_versions.',
};

/**
 * Insert-only tables (spec 6.1). Their repositories expose no update or delete methods; the application DB role
 * is granted no UPDATE/DELETE on them (tooling/scripts/db-roles.sql). release_approvals and publication_attempts
 * are append-plus-outcome: only the state/outcome columns move, by transition.
 */
export const INSERT_ONLY_TABLES: readonly string[] = [
  'creative_revisions',
  'rendered_exports',
  'review_decisions',
  'remote_evidence',
  'metric_snapshots',
  'link_clicks',
  'usage_ledger',
  'audit_events',
  'agent_steps',
  'tool_invocations',
  'evaluation_results',
  'experiment_assignments',
  'experiment_results',
  'content_revisions_snapshot_placeholder',
].filter((t) => !t.endsWith('_placeholder'));
