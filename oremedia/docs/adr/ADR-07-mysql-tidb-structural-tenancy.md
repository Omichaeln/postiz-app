# ADR-07: PointFive OS stack on MySQL/TiDB with structural tenant enforcement in lieu of Postgres RLS

**Status:** Proposed
**Date:** 23 September 2026
**Reversal cost:** High after Phase 2.

## Decision

MySQL 8 or TiDB (D-01). No row-level security exists; the mitigation is structural and mandatory: scoped
repositories, `oremedia/no-raw-db`, composite tenant keys and foreign keys, the schema tenancy check
(`tooling/scripts/check-schema-tenancy.ts`), and the cross-tenant CI harness. If a later ADR demands
database-enforced RLS as a hard control, that requirement overturns this choice and must be raised explicitly.

## Working assumption for this build

MySQL 8.0 (the local and CI test engine). TiDB-specific hotspot handling (`NONCLUSTERED` keys,
`SHARD_ROW_ID_BITS`, non-monotonic IDs on high-write tables) is documented in `packages/db/README.md` and applied
only if D-01 selects TiDB.
