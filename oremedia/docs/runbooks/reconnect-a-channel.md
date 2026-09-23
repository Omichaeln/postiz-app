# Runbook: reconnect a channel

**Symptom:** `channel_connections.status` is `refresh_needed` or `reconnect_needed`; metric `oremedia.channels.reconnect_needed` > 0; publishers were notified; publications for the channel are `held` with reason `channel_active`.
**Owner:** publisher of the brand (customer) with platform support. **Exercised:** not yet (Phase 5 dependency).

1. Confirm the state: `publishing.channels.list` for the brand shows the connection and its status; the audit trail shows the last `tokenRefreshWorkflowV1` failure reason.
2. If `refresh_needed`: trigger `publishing.channels.refresh` (idempotent; takes the per-connection lock). If the refresh succeeds the status returns to `active` and held publications stay held until a person re-releases them (they were held for a reason; review timing).
3. If `reconnect_needed`: the publisher runs `publishing.channels.connect.start` for the same provider and remote account. The new grant writes a **new** `credential_refs` row; the old row is destroyed within 24 hours (spec 17.5).
4. Missing scopes: the connect flow reports `missingScopes` against the capability's `requiredScopes`; the channel is not usable until they are granted.
5. Re-release each held publication from the calendar (`held → scheduled`), which re-runs the release policy at dispatch.
6. Verify: a test post is not required; the next scheduled publication reaches `published` and `outcome_unknown` count does not grow.

Escalate to platform if the provider app itself is suspended (all connections of that provider fail at once).
