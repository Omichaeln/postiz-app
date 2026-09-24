# Runbook: roll back a workflow version safely

**When:** a newly deployed workflow version (e.g. `publicationWorkflowV2`) misbehaves.
**Owner:** platform on-call. **Exercised:** locally by `packages/workflows/test/workflow-versions.test.ts`: every committed `*.workflow.v<N>.ts` is byte-identical to its first commit and was never modified after it (a change must ship as v<N+1>), and every queue entry (`packages/workflows/src/queues/*.ts`) that serves a workflow family exports every version of it present, so old versions stay registered while new ones roll out. **Needs a live environment for:** the Temporal UI drain check (step 2), signals to in-flight workflows (step 3) and recorded-history replay (step 4: no histories are recorded yet; the time-skipping test server cannot be downloaded here).

Workflow code is immutable once deployed (spec 14.3): never edit a deployed workflow in place.

1. Stop **starting** the new version: outbox routes are code (`register*OutboxRoutes` in each module, composed in `apps/worker-core/src/composition.ts`), so redeploy the worker-core build whose route starts V1 (there is no runtime `workflowRouting` switch). Keep V2 exported from its queue entry.
2. Keep the workers that register the new version running until every in-flight history of that version has closed (Temporal UI: running workflows of type V2 = 0). Removing the code first would fail those histories with non-determinism errors.
3. In-flight V2 publications that cannot safely continue: signal cancel where not yet dispatched; those past `openAttempt` proceed to reconciliation, never re-sent.
4. Replay tests: the recorded histories for V1 and V2 must both pass in CI before any redeploy.
5. Verify: no non-determinism errors in worker logs; dispatch lateness and `outcome_unknown` metrics back to baseline.
