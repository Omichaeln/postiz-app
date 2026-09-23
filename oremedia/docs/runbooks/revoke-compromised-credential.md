# Runbook: revoke a compromised credential, API client, skill or template

**Owner:** tenant owner/admin; platform on-call for platform-level secrets. **Exercised:** API-client revocation and rotation are covered by `api.integration.test.ts`; production procedure not yet exercised.

| What                                           | Action                                                                                 | Effect                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| API client key                                 | `access.apiClients.rotate` (or `servicePrincipals.revoke` for all keys of a principal) | Old key hash rejected immediately (`UNAUTHENTICATED`); audited                     |
| Social token                                   | `publishing.channels.disconnect`                                                       | Credential row destroyed; KMS data key discarded; publications on the channel held |
| Session                                        | `access.sessions.revokeAll` for the user (also automatic on role change)               | Cookies/bearers rejected on next request                                           |
| Skill version                                  | `skills.versions.retire` and set the previous version active                           | Future runs pin the previous version; history untouched                            |
| Template version                               | `creative.templates.retire`                                                            | No new documents from it; existing revisions untouched                             |
| Platform secret (KMS key, provider app secret) | Rotate in the secret manager, redeploy affected services                               | Re-encrypt credentials with a re-wrap job if the KMS key changes                   |

Always: record an incident (`operations.incidents`), check the audit trail for use of the credential after the suspected exposure, and notify affected brands.
