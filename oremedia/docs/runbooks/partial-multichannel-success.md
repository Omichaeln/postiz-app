# Runbook: handle partial multi-channel success

**Symptom:** a package shows some channels `published` and others `failed`, `outcome_unknown` or `held`.
**Owner:** publisher. **Exercised:** not yet (Phase 5).

Each channel is its own publication and workflow (spec 14.4). Successful channels are never republished to repair another.

1. Read each failed channel's reason: `failed` (definitive provider rejection: fix the variant, e.g. media dimensions or text length flagged by `capability_valid`), `held` (release policy reasons listed), `outcome_unknown` (follow the reconcile runbook).
2. Fixing a variant creates a new content revision → the approval binding no longer matches → a fresh approval is required for that channel only. Request review for the changed variant.
3. Re-schedule the fixed channel with the same occurrence (no duplicate) or a new time.
4. Verify: every channel is in a definitive state; the calendar shows per-channel outcomes and evidence links.
