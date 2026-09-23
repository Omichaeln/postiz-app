# @oremedia/db

Schema, migrations, tenant context and the scoped repository base (spec 5, 6).

## Rules that this package enforces

- `requireTenant()` throws `TENANT_CONTEXT_MISSING` when no context is set. There is no fallback to all rows.
- `TenantScopedRepository` injects the tenant predicate into every read, update and delete and stamps `tenant_id`
  on every insert. `BrandScopedRepository` additionally requires `brandId ∈ ctx.brandIds`.
- `PlatformRepository` (cross-tenant projections) only works inside `runAsPlatform(job, correlationId, fn)`.
- The raw client (`src/client.ts`) is importable only inside this package (`oremedia/no-raw-db`).
- Every table has a `tenant_id` column or is justified in `src/global-tables.ts` (`pnpm check:schema`).
- Insert-only tables have no update methods in their repositories and no UPDATE/DELETE grant for the app role
  (`tooling/scripts/generate-db-roles.ts` → `roles/app-role.sql`; verified by `immutability.integration.test.ts`).

## Migrations

`pnpm db:generate` (drizzle-kit) writes a versioned SQL file to `migrations/`; `pnpm db:migrate` applies it
with `DATABASE_URL`. Expand/contract only: never a destructive change in the same release as the code that stops
needing the old shape. Schema pushes with data-loss acceptance are prohibited (spec 2.1.11).

## Engine notes (D-01)

MySQL 8 InnoDB enforces the composite foreign keys natively. If TiDB is chosen:

- verify foreign-key enforcement on the exact cluster version; if not enforced, the repository assertions plus a
  scheduled integrity job (`operations` module, to be added under D-01) take over;
- high-write tables (`outbox_events`, `publication_attempts`, `metric_snapshots`, `audit_events`,
  `tool_invocations`, `link_clicks`, `usage_ledger`) get `NONCLUSTERED` primary keys with `SHARD_ROW_ID_BITS`
  in the generated migration SQL, and non-monotonic ids (`newShardedId` in `@oremedia/domain/ids`);
- time-leading secondary indexes (`ix_outbox_ready`, `ix_publication_due`) remain hotspots and must be
  load-tested against the target write rate.

## Testing

`createTestDatabase()` uses `TEST_DATABASE_URL` (CI service container or a local MySQL 8) to create a fresh
database per test file and apply migrations; without it, Testcontainers starts `mysql:8.0` (needs Docker).
