# ADR-02: Company = tenant; brands are children; portfolio is a projection

**Status:** Proposed
**Date:** 23 September 2026
**Reversal cost:** Very high after real client data.

## Context

Agencies operate many client companies; each company owns brands. The security boundary must be unambiguous.

## Decision

`Company` = tenant = security boundary. A company owns brands. A user holds memberships in many companies with a
role per company and optional per-brand grants. A billing account may pay for several companies without gaining
data access. An agency portfolio is a _projection_ over the operator's memberships, never a shared container.
Cross-brand reuse inside a tenant requires an `asset_grant` or a reviewed copy. Cross-tenant sharing is a copy with
provenance, never a shared mutable row.

## Enforcement

Every tenant-owned row carries `tenant_id`; brand-owned rows carry `brand_id` and reference their parent by
`(tenant_id, brand_id, id)` (composite foreign keys in `packages/db/src/schema`). `TenantScopedRepository`
injects the predicate. The cross-tenant harness attempts foreign access on every entry point.

## Consequences

Holding-company relationships and cross-company asset transfer are later, gated capabilities.
