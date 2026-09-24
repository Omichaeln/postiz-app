# Runbook: process a deletion request (spec 17.5)

**When:** a tenant owner/admin asks for a brand or the whole tenant to be deleted (`operations.deletion.request`),
or a retention question comes up. **Owner:** platform on-call (the automated fan-out runs by itself; the operator
completes the stores the worker cannot reach). **Exercised:** locally by
`apps/worker-core/src/deletion.integration.test.ts`: a tenant deletion through the API and the outbox route runs
`deletionRequestWorkflowV1` (fake Temporal host, real activities) and leaves no row of the tenant in any
tenant-scoped table except audit events, release evidence and the request itself, anonymises its users, deletes its
objects, crypto-shreds its credentials, leaves the other tenant byte-for-byte untouched and is a no-op on a second
run; a brand deletion narrows to the brand; the retention sweep's dry run counts and its real run removes only rows
past their TTL; the operator confirmations complete the request. The re-application after a restore is exercised
by `runbooks.integration.test.ts` ("restore a single tenant"). **Needs a live environment for:** the Temporal
namespace retention check, the log backend purge, bucket versioning/lifecycle, backup expiry, and the DELETE grant
of the retention database role on the insert-only tables (the local run uses root).

## What runs by itself

1. `operations.deletion.request { subjectType: 'tenant' | 'brand', subjectId, reason }` (owner/admin,
   `billing.manage`, audited `deletion.request`) records a `deletion_requests` row and emits
   `operations.deletion_requested`; the outbox starts `deletionRequestWorkflowV1` on task queue `core` with workflow
   id `deletion:<deletionRequestId>` (USE_EXISTING: a redelivered event joins it).
2. The workflow runs every registered handler as its own activity, in order (`apps/worker-core/src/deletion-handlers.ts`):
   `credentials` (crypto-shred: wrapped data key and ciphertext overwritten), `objects` (every storage key the rows
   name, tenant prefix checked), then `agents`, `review`, `publishing`, `measurement`, `community`, `intelligence`,
   `experiments`, `content`, `creative`, `assets`, `skills`, `billing`, `brand`, `operations`, `access` (rows purged
   children-first in batches; users left without any membership anonymised; the tenant row kept as a tombstone), and
   `indexes`. Retained by design: `audit_events`, `remote_evidence`, `deletion_requests` (spec 17.5 audit and
   release evidence).
3. Each step records its completion on the request (`fanout.<handler>` and the store roll-up
   `fanout.database` / `object_storage` / `indexes` …) and an audit event `deletion.step` with the per-table counts
   (`metadata.evidence`, e.g. `publications=3,publication_attempts=3`). A retried step finds its entry done and
   skips. The request ends `blocked` with `blocked_reason = operator action required: temporal_visibility, logs,
backups, provider_side`.

## Operator steps (the `blocked` stores)

Find open requests: `SELECT id, tenant_id, subject_type, subject_id, state, blocked_reason, fanout FROM
deletion_requests WHERE state <> 'completed'` (platform read-only session), and the evidence: `operations.audit.query
{ query: { resourceType: 'deletion_request', resourceId } }` in the tenant.

1. **temporal_visibility.** Workflow ids and search attributes carry ids only (no names or content). Running
   workflows of the deleted tenant end at their next activity (their rows are gone: NOT_FOUND, non-retryable).
   Closed histories expire with the namespace retention; record the date:
   `temporal operator namespace describe --namespace "$TEMPORAL_NAMESPACE"` (Retention) — completion date =
   request completion + retention. For an early purge of a known workflow id:
   `temporal workflow delete --namespace "$TEMPORAL_NAMESPACE" --workflow-id "deletion:<deletionRequestId>"` (and any
   `pub:<publicationId>`, `render:<renderJobId>`, `run:<runId>`, `ingest:<uploadIntentId>`, `metrics:<publicationId>`
   ids listed in the request's audit trail). Workflows have no TenantId search attribute (open: add one so a
   `--query 'TenantId="…"'` purge is possible).
2. **logs.** Logs carry allowlisted fields only (ids, codes). Confirm the log sink's retention (≤ 30 days) and record
   the expiry date, or purge by `tenantId` in the log backend.
3. **backups.** Backups expire with the PITR window; record the expiry date. Any restore before it must re-apply this
   request (restore-single-tenant step 6: `deletion.reapply`, then the workflow again).
4. **provider_side.** Posts stay on the platforms unless the tenant asked for removal before deletion
   (`publishing.publications.deleteRemote` per post). Record what was asked.
5. Record each step: `deletion.confirmOperatorAction(actor, deletionRequestId, step, note)` (operations module; no API
   procedure yet, open) — the request completes when no step is left (`deletion.operator_action` audited).
6. Object versions: the `objects` step deletes the current object; noncurrent versions go with the bucket's lifecycle
   rule (noncurrent version expiry), as do `releases/<tenant>/` copies. Confirm the rule on both buckets once.

## Retention (the daily TTL sweep)

`retentionSweepWorkflowV1` runs daily at 02:30 UTC from the Temporal schedule `retention-sweep` (created by
worker-core at start). It is a **dry run** (counts only, `retention.apply` audit only on a real run) unless the
schedule was created with `RETENTION_SWEEP_APPLY=true`. Classes and defaults (D-09 to confirm): agent transcripts
90 days (`agent_steps`, `tool_invocations`; run summaries kept), metrics 25 months (`metric_snapshots`,
`link_clicks`), raw customer-voice messages 12 months (`messages`; cluster sample refs cleared). A tenant's
`retention_policies` row overrides the days; `retention_days = NULL` keeps the class indefinitely. To switch the
schedule to apply mode: `temporal schedule update --schedule-id retention-sweep --workflow-type retentionSweepWorkflowV1
--task-queue core --input '{"dryRun":false}' …` (or delete it and restart worker-core with `RETENTION_SWEEP_APPLY=true`).

## Database role

The application role has no DELETE on insert-only tables (spec 6.1, `packages/db/roles/app-role.sql`). The purge of
`creative_revisions`, `rendered_exports`, `review_decisions`, `metric_snapshots`, `link_clicks`, `usage_ledger`,
`agent_steps`, `tool_invocations`, `evaluation_results`, `experiment_assignments` and `experiment_results` needs a
retention role with DELETE on them, used only by worker-core's deletion and retention activities. **Open:** the role
and its connection (`DATABASE_URL_RETENTION`) are not generated or wired yet; until then the deletion fails those
steps with `ER_TABLEACCESS_DENIED_ERROR` in an environment that uses the application role (the step stays pending
and is retried; nothing is half-deleted inside a step, since each step is one transaction).
