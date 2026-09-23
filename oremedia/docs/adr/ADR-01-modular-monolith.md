# ADR-01: Modular monolith API and three Temporal worker pools

**Status:** Proposed (acceptance requires a named owner; see `docs/decisions/DECISIONS.md`)
**Date:** 23 September 2026
**Reversal cost:** Low if module boundaries are enforced.

## Context

Oremedia needs an application API, durable background work (agent runs, publication, reconciliation), CPU-heavy
rendering, and scheduled ingestion. The specification (section 4) requires no microservices.

## Options

1. Modular monolith + three worker pools (specification recommendation).
2. Service per bounded context.
3. Single process running API and all workers.

## Decision

Option 1. `apps/api` (Express 4 + tRPC 11) hosts every module behind public service interfaces. Three worker
pools: `worker-core` (authority-bearing work, credential-broker access), `worker-render` (Chromium/sharp,
no credentials, restricted egress), `worker-ingest` (scheduled pulls). Module boundaries are enforced in CI by
`eslint-plugin-boundaries` and `oremedia/module-table-ownership`.

## Boundary matrix (as enforced)

See the header comment of `eslint.config.js`. Two deliberate additions to the specification's short list: modules
may import `packages/observability` (logging is cross-cutting) and the module-specific packages they orchestrate
(`creative → editor`, `publishing → providers`, `agents → ai`). Neither introduces a table dependency.

## Consequences

A module is split into its own deployable only when it has a measured need for independent scaling or deployment
cadence and an owner able to run it.

## Rollout / rollback

Not applicable at Phase 0; boundaries are compile-time.
