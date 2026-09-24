# Runbook: drain and replay the outbox and dead letters

**Symptom:** alert `oremedia.outbox.oldest_undispatched_age_ms` > 60 s, or `oremedia.outbox.dead_letters` > 0 (attempts ≥ 5).
**Owner:** platform on-call. **Exercised:** dispatcher, dead-letter listing and replay verified by `packages/modules/operations/src/outbox-dispatcher.integration.test.ts` and the cross-tenant harness; not yet walked through on a live environment.

1. Is the dispatcher running? Check `worker-core` logs for `outbox dispatch` lines and Temporal connectivity errors. A stopped dispatcher is the common cause; restart the service (Railway → redeploy) before anything else.
2. Is Temporal reachable? `TEMPORAL_ADDRESS`/namespace/certificate errors appear as `lastError` on the events. Fix connectivity; events resume automatically (lease-based claiming, backoff).
3. Dead letters (attempts ≥ 5): `operations.outbox.deadLetters` lists the caller's tenant's dead letters (requires `audit.read`); the platform-wide count is the `oremedia.outbox.dead_letters` gauge from worker-core, and the rows are `outbox_events` with `dispatched_at IS NULL AND attempts >= 5`. Read `lastError`. Typical causes: a payload referencing a deleted aggregate (safe to discard with a note), a workflow start rejected by a validation bug (fix, then replay).
4. Replay: `operations.outbox.replay { eventId }` (tenant admin, `billing.manage`, audited) makes the event claimable now and clears `lastError`; `attempts` is kept so the history stays honest. The dispatcher picks it up on its next pass (≤ 1 s idle poll). Replays are idempotent downstream (workflow ids are stable; the database row is the dedupe authority).
5. Stale claims: events with `claimedBy` set and `claimExpiresAt` in the past are reclaimed automatically; nothing to do.
6. Verify: oldest-undispatched age returns below 60 s; dead-letter count is 0 or each remaining one has a written disposition.

## Events without a consumer

An event type with no registered route is marked dispatched with `ignored` (counted in the `routed=no` dispatch
metric) and is not replayable: a consumer registered later (a Phase 5 or 6 workflow) starts from the events
emitted after its route exists. Register the route in `apps/worker-core/src/composition.ts` before the producer
ships when historic events must reach the new consumer.
