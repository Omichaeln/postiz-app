# Oremedia engineering conventions

Binding source: `docs/spec/BUILD_PROMPT.md` (the specification). This file is the short operational digest every
contributor and implementing agent reads before touching code. Where they disagree, the specification wins.

## Placement and layering

The repository layout is specification section 3.3. The dependency rule is enforced by `eslint-plugin-boundaries`
in `eslint.config.js` (see the comment block there for the exact matrix). Custom rules in
`tooling/eslint-config`:

| Rule                                    | Enforces                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `oremedia/no-raw-db`                    | The raw Drizzle client is importable only inside `packages/db` (outbox dispatcher allowlisted by path). |
| `oremedia/no-provider-branching`        | No `if (provider === 'x')` outside `packages/providers`.                                                |
| `oremedia/no-direct-fetch-in-providers` | Adapters do network I/O only through `ProviderIO`.                                                      |
| `oremedia/module-table-ownership`       | A module imports only the schema file it owns (spec 4.2).                                               |

## One way of doing each thing

| Concern              | The one way                                                                                          | Where                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Tenant scoping       | `TenantScopedRepository` / `BrandScopedRepository`; `requireTenant()` throws when context is missing | `packages/db/src/scoped-repository.ts`                     |
| Transactions         | `withTransaction(tx?, fn)`; commands accept `tx`                                                     | `packages/db/src/transaction.ts`                           |
| Authorisation        | `authorize(input)` pure decision + `policy.assert` in the access module                              | `packages/domain/src/policy.ts`, `packages/modules/access` |
| Errors               | `OremediaError` subclasses; `toErrorEnvelope` at the edge                                            | `packages/contracts/src/errors.ts`                         |
| IDs                  | `newId(kind)` prefixed ULIDs                                                                         | `packages/domain/src/ids.ts`                               |
| Hashing              | `hashCanonical` (RFC 8785) and `hashText` (NFC, trailing trim)                                       | `packages/domain/src/hash.ts`                              |
| State                | `machine.transition(from, event)`; never assign a state string                                       | `packages/domain/src/state-machines`                       |
| Idempotent mutations | `idempotent(ctx, (tx) => command)`                                                                   | `packages/modules/operations/src/idempotent.ts`            |
| Events               | `outbox.add(type, data, tx)` in the same transaction as the write                                    | `packages/modules/operations/src/outbox.ts`                |
| Audit                | `audit.record(actor, action, resource, decision, tx)`                                                | `packages/modules/operations/src/audit.ts`                 |
| Pagination           | `PageRequest` / `Page<T>`; cursor = opaque base64 of sort key + id                                   | `packages/contracts/src/pagination.ts`                     |
| Provider I/O         | `ProviderIO.request` only                                                                            | `packages/providers/src/io.ts`                             |
| Model calls          | `ModelAdapter.complete`                                                                              | `packages/ai/src/model-adapter.ts`                         |

## Contracts before implementations

For every module: Zod schemas and TypeScript types in `packages/contracts` first, then the tRPC router or
worker interface, then tests, then the implementation.

## Data conventions (spec 6.1)

Prefixed ULIDs (`varchar(32)`), `datetime(3)` UTC, money in integer micro-units, `version int` for optimistic
concurrency, insert-only evidence tables (no update methods on their repositories), SHA-256 hex hashes,
versioned JSON documents validated on read and write, composite `(tenant_id, brand_id, id)` integrity, no
soft delete by default.

## Verification language

Report every gate and checklist item as **verified** (how), **open** (risk) or **not applicable** (why).
"It should work" is not a status. Never fabricate a verification.

## Postiz

Postiz (the parent directory of this tree, pinned at commit `4c33d525`) is a reference, not a dependency.
No code is copied from it unless ADR-06 records acceptance of the AGPL route.
