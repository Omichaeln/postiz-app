# Runbooks (spec 17.7)

Every runbook must be exercised once before pilot publication. Status is tracked in the progress ledger (Phase 7).

| Runbook                                                                                            | Exercised (locally; see each runbook's "needs a live environment for:" line)                        |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Deploy on Railway](deploy-railway.md)                                                             | No (needs the Railway account)                                                                      |
| [Reconnect a channel](reconnect-a-channel.md)                                                      | `apps/worker-core/src/runbooks.integration.test.ts` (7.4)                                           |
| [Reconcile an outcome_unknown publication](reconcile-outcome-unknown.md)                           | `apps/worker-core/src/runbooks.integration.test.ts` (7.5)                                           |
| [Drain and replay the outbox and dead letters](outbox-drain-and-replay.md)                         | `apps/worker-core/src/runbooks.integration.test.ts` (7.6)                                           |
| [Engage the kill switch](kill-switch.md)                                                           | `apps/worker-core/src/runbooks.integration.test.ts` (7.7); mandate path only                        |
| [Handle partial multi-channel success](partial-multichannel-success.md)                            | `apps/worker-core/src/runbooks.integration.test.ts` (7.8); known defect recorded                    |
| [Recover rendering](recover-rendering.md)                                                          | `apps/worker-render/src/recover-rendering.integration.test.ts` (7.9)                                |
| [Revoke a compromised credential, API client, skill or template](revoke-compromised-credential.md) | `apps/worker-core/src/runbooks.integration.test.ts` (7.10); skill/template retire have no procedure |
| [Restore a single tenant](restore-single-tenant.md)                                                | `apps/worker-core/src/runbooks.integration.test.ts` (7.11); restore hold command missing            |
| [Respond to a suspected cross-tenant exposure](suspected-cross-tenant-exposure.md)                 | `apps/worker-core/src/runbooks.integration.test.ts` (7.12)                                          |
| [Roll back a workflow version safely](rollback-workflow-version.md)                                | `packages/workflows/test/workflow-versions.test.ts` (7.13)                                          |
| [Process a deletion request](process-deletion-request.md)                                          | `apps/worker-core/src/deletion.integration.test.ts` (7.16)                                          |
| [Certify a channel](certify-a-channel.md)                                                          | No (needs each platform's app)                                                                      |
