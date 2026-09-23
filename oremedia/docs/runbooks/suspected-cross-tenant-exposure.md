# Runbook: respond to a suspected cross-tenant exposure

**Severity:** sev1 until proven otherwise. **Owner:** platform on-call + security lead. **Exercised:** not yet.

1. Contain: engage the tenant-wide kill switches for the affected tenants; if the suspect path is an API, disable the endpoint by flag or redeploy the previous build.
2. Preserve evidence: audit events (`resourceType`, `actorId`, `correlationId`), request logs by correlation id, the exact build SHA.
3. Determine scope: which procedure/route, which actor, which rows. The cross-tenant harness fixtures are the checklist of entry points; re-run them against the deployed build.
4. Fix: the mandatory-baseline controls are the scoped repository and the policy engine; a leak means one of them was bypassed (raw db access, missing `getById` before use, missing `policy.assert`). Add the regression to the harness, fix, redeploy.
5. Notify: affected tenants per contract; regulator obligations per D-02/D-09.
6. Postmortem within five working days; action items tracked in `incidents`.
