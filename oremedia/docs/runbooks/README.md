# Runbooks (spec 17.7)

Every runbook must be exercised once before pilot publication. Status is tracked in the progress ledger (Phase 7).

| Runbook                                                                                            | Exercised (locally; see each runbook's "needs a live environment for:" line)                            |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Deploy on Railway](deploy-railway.md)                                                             | No (needs the Railway account)                                                                          |
| [Reconnect a channel](reconnect-a-channel.md)                                                      | `apps/worker-core/src/runbooks.integration.test.ts` (7.4)                                               |
| [Reconcile an outcome_unknown publication](reconcile-outcome-unknown.md)                           | `apps/worker-core/src/runbooks.integration.test.ts` (7.5)                                               |
| [Drain and replay the outbox and dead letters](outbox-drain-and-replay.md)                         | `apps/worker-core/src/runbooks.integration.test.ts` (7.6)                                               |
| [Engage the kill switch](kill-switch.md)                                                           | `apps/worker-core/src/runbooks.integration.test.ts` (7.7); mandate path only                            |
| [Handle partial multi-channel success](partial-multichannel-success.md)                            | `apps/worker-core/src/runbooks.integration.test.ts` (7.8); known defect recorded                        |
| [Recover rendering](recover-rendering.md)                                                          | `apps/worker-render/src/recover-rendering.integration.test.ts` (7.9)                                    |
| [Revoke a compromised credential, API client, skill or template](revoke-compromised-credential.md) | `apps/worker-core/src/runbooks.integration.test.ts` (7.10); skill/template retire have no procedure     |
| [Restore a single tenant](restore-single-tenant.md)                                                | `apps/worker-core/src/runbooks.integration.test.ts` (7.11), with `publishing.publications.holdRestored` |
| [Respond to a suspected cross-tenant exposure](suspected-cross-tenant-exposure.md)                 | `apps/worker-core/src/runbooks.integration.test.ts` (7.12)                                              |
| [Roll back a workflow version safely](rollback-workflow-version.md)                                | `packages/workflows/test/workflow-versions.test.ts` (7.13)                                              |
| [Process a deletion request](process-deletion-request.md)                                          | `apps/worker-core/src/deletion.integration.test.ts` (7.16)                                              |
| [Certify a channel](certify-a-channel.md)                                                          | No (needs each platform's app)                                                                          |

## Platform on-call access (spec 5.7)

Runbooks that say "platform on-call under a support session" (for example [kill switch](kill-switch.md)) mean:
the operator opens a support session (`accessService.openSupportSession`: reason, ticket, consent flag, time box,
read-only) and calls the API with the `sup_<sessionToken>.<supportSessionId>` bearer. Writes need a **second**
operator, inside their own support session on the same tenant, to call `access.supportSessions.escalate` (the
opener cannot escalate their own session; the escalation only shortens the expiry, default 30 minutes). Every
request of the session, allowed or refused, is audited with its `supportSessionId` (`support.request`, plus
`support.open` and `support.escalate`). Exercised by `apps/api/src/support-sessions.integration.test.ts`.
