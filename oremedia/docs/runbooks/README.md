# Runbooks (spec 17.7)

Every runbook must be exercised once before pilot publication. Status is tracked in the progress ledger (Phase 7).

| Runbook                                                                                            | Exercised                           |
| -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| [Deploy on Railway](deploy-railway.md)                                                             | No (needs the Railway account)      |
| [Reconnect a channel](reconnect-a-channel.md)                                                      | No                                  |
| [Reconcile an outcome_unknown publication](reconcile-outcome-unknown.md)                           | No                                  |
| [Drain and replay the outbox and dead letters](outbox-drain-and-replay.md)                         | No                                  |
| [Engage the kill switch](kill-switch.md)                                                           | Locally by integration test         |
| [Handle partial multi-channel success](partial-multichannel-success.md)                            | No                                  |
| [Recover rendering](recover-rendering.md)                                                          | No                                  |
| [Revoke a compromised credential, API client, skill or template](revoke-compromised-credential.md) | API-client part by integration test |
| [Restore a single tenant](restore-single-tenant.md)                                                | No                                  |
| [Respond to a suspected cross-tenant exposure](suspected-cross-tenant-exposure.md)                 | No                                  |
| [Roll back a workflow version safely](rollback-workflow-version.md)                                | No                                  |
