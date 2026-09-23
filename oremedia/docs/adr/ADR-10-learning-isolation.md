# ADR-10: Learning isolation per tenant/brand; evidence strength taxonomy; baseline comparison

**Status:** Proposed
**Date:** 23 September 2026
**Reversal cost:** Medium.

## Decision

Learning, embeddings, clusters and playbooks are per tenant and per brand. Evidence strength is
`observed < directional < experimentally_supported`. Recommendation ranking is evaluated monthly against a stable
baseline policy on later, unseen results; if it does not beat the baseline by the stated margin it is flagged and the
baseline is used. Engagement gains never rewrite brand standards automatically. Any future cross-tenant benchmark
requires its own ADR with k-anonymity thresholds and opt-in.
