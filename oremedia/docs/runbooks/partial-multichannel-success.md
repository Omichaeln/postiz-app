# Runbook: handle partial multi-channel success

**Symptom:** a package shows some channels `published` and others `failed`, `outcome_unknown` or `held`.
**Owner:** publisher. **Exercised:** locally — each channel is its own publication row and workflow (`pub:<publicationId>`), and `publishing.integration.test.ts` drives rejected / held / outcome_unknown rows side by side with published ones for the same brand. Production procedure not yet exercised.

Each channel is its own publication and workflow (spec 14.4). Successful channels are never republished to repair another: a re-release only ever targets the one row you name, and the occurrence key `(contentRevisionId:channelConnectionId:occurrence)` makes a second row for a published channel a CONFLICT.

1. List the package's channels: `publishing.publications.list { brandId, state? }` (filter by state) or `content.calendar.range`, then `publishing.publications.get { publicationId }` per row for `stateReason`, `holdReasons` and `attempts[]`.
2. Read each non-published channel's reason: `failed` (definitive provider rejection; `stateReason` carries the adapter's code, e.g. a `capability_valid` issue such as text length or media dimensions), `held` (`holdReasons` lists the failed release checks), `outcome_unknown` (follow the reconcile runbook).
3. Fixing a variant creates a new content revision → the approval binding no longer matches → a fresh approval is required for that channel only. Request review for the changed variant.
4. Re-schedule the fixed channel only: `publishing.publications.schedule` for the new revision's variant (a new occurrence key because the revision changed), or `publications.reschedule` for a `held` / `retry_eligible` row of the same revision (same occurrence, new attempt).
5. Verify: every channel of the package is in a definitive state; the published channels' rows and `remote_evidence` are untouched (their `version` did not move).
