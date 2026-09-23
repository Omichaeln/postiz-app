# Runbook: roll back a workflow version safely

**When:** a newly deployed workflow version (e.g. `publicationWorkflowV2`) misbehaves.
**Owner:** platform on-call. **Exercised:** not yet (Phase 5).

Workflow code is immutable once deployed (spec 14.3): never edit a deployed workflow in place.

1. Stop **starting** the new version: point the outbox router back to the previous version (`operations.workflowRouting.set { type: 'publication', version: 'v1' }`) or redeploy the API/dispatcher build that starts V1.
2. Keep the workers that register the new version running until every in-flight history of that version has closed (Temporal UI: running workflows of type V2 = 0). Removing the code first would fail those histories with non-determinism errors.
3. In-flight V2 publications that cannot safely continue: signal cancel where not yet dispatched; those past `openAttempt` proceed to reconciliation, never re-sent.
4. Replay tests: the recorded histories for V1 and V2 must both pass in CI before any redeploy.
5. Verify: no non-determinism errors in worker logs; dispatch lateness and `outcome_unknown` metrics back to baseline.
