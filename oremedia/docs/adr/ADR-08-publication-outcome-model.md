# ADR-08: Publication outcome model: attempt ledger, fencing, `outcome_unknown`, reconciliation; no blind mutation retries

**Status:** Proposed
**Date:** 23 September 2026
**Reversal cost:** Must hold before first live publish.

## Decision

The `publication_attempts` row is committed before any outbound call; `sentAt` is committed immediately before the
mutation. An attempt without `sentAt` proves the call was not made. A heartbeat timeout is `unknown`. Ambiguous
outcomes reconcile (`findRemotePost`) with backoff, then hold for a human. Temporal retries are `maximumAttempts: 1`
on the provider mutation. Rescheduling signals the workflow and never terminates it. The database row is the dedupe
authority (`occurrence_key` unique per tenant); workflow IDs are stable.
