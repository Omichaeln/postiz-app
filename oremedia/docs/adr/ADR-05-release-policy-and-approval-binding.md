# ADR-05: Deterministic release policy gates every external effect; approval binding by content hash

**Status:** Proposed
**Date:** 23 September 2026
**Reversal cost:** Must hold before first live publish.

## Decision

`ApprovalBindingV1` hashes exactly what was approved (text, exports, settings, channels, timing, brand and policy
version) with RFC 8785 canonical JSON. `evaluateRelease` recomputes the binding from live rows at dispatch and
compares hashes; eager invalidation hooks are UX only. There is no agent tool that publishes; a mandate completes
`publications.proposeSchedule` only when the deterministic policy passes at execution.
