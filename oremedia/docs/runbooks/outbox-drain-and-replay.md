# Runbook: drain and replay the outbox and dead letters

**Symptom:** alert `oremedia.outbox.oldest_undispatched_age_ms` > 60 s, or `oremedia.outbox.dead_letters` > 0 (attempts ≥ 5).
**Owner:** platform on-call. **Exercised:** not yet (dispatcher is Phase 5).

1. Is the dispatcher running? Check `worker-core` logs for `outbox dispatch` lines and Temporal connectivity errors. A stopped dispatcher is the common cause; restart the service (Railway → redeploy) before anything else.
2. Is Temporal reachable? `TEMPORAL_ADDRESS`/namespace/certificate errors appear as `lastError` on the events. Fix connectivity; events resume automatically (lease-based claiming, backoff).
3. Dead letters (attempts ≥ 5): open the dead-letter view (`operations.outbox.deadLetters`), read `lastError`. Typical causes: a payload referencing a deleted aggregate (safe to discard with a note), a workflow start rejected by a validation bug (fix, then replay).
4. Replay: `operations.outbox.replay { eventId }` resets `attempts` and `availableAt`; the dispatcher picks it up. Replays are idempotent downstream (workflow ids are stable; the database row is the dedupe authority).
5. Stale claims: events with `claimedBy` set and `claimExpiresAt` in the past are reclaimed automatically; nothing to do.
6. Verify: oldest-undispatched age returns below 60 s; dead-letter count is 0 or each remaining one has a written disposition.
