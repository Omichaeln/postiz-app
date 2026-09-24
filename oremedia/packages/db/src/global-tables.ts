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
  'render_previews', // the proposed snapshot a preview job draws: written with the job, never updated
  'preview_exports', // a preview render's output, evidence like rendered_exports
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

export type RetentionPrivilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * Spec 17.5 / 6.1: the retention database role (`roles/retention-role.sql`, connection DATABASE_URL_RETENTION) is
 * used only by retentionSweepWorkflowV1's activities. It carries exactly what the registered TTL handlers and the
 * retention audit need: DELETE on the insert-only tables a TTL class removes by age (and nothing else insert-only),
 * DELETE/UPDATE on the mutable rows those classes remove or anonymise, SELECT to find them, INSERT on audit_events
 * for the `retention.apply` record. audit_events, creative_revisions, rendered_exports and every other evidence
 * table stay undeletable. Adding a TTL class that removes another table means adding it here and regenerating.
 */
export const RETENTION_ROLE_GRANTS: Readonly<Record<string, readonly RetentionPrivilege[]>> = {
  retention_policies: ['SELECT'],
  // agent_transcripts (90 days)
  agent_steps: ['SELECT', 'DELETE'],
  tool_invocations: ['SELECT', 'DELETE'],
  // metrics (25 months)
  metric_snapshots: ['SELECT', 'DELETE'],
  link_clicks: ['SELECT', 'DELETE'],
  // customer_voice_raw (12 months): messages removed, cluster sample refs cleared
  messages: ['SELECT', 'DELETE'],
  customer_voice_clusters: ['SELECT', 'UPDATE'],
  audit_events: ['INSERT'],
};
