# Runbook: respond to a suspected cross-tenant exposure

**Severity:** sev1 until proven otherwise. **Owner:** platform on-call + security lead. **Exercised:** locally by `apps/worker-core/src/runbooks.integration.test.ts` ("suspected cross-tenant exposure (7.12)"): both kill switches engaged tenant-wide under the incident's correlation id, the audit query returns exactly those engage events with actor and correlation id (step 2), and every procedure's cross-tenant fixture is re-run as the other tenant against this build with no leak and no write landing in the investigated tenant (step 3). **Needs a live environment for:** request logs by correlation id, the deployed build SHA, disabling an endpoint by flag or redeploy, tenant and regulator notification. There is no `incidents` API yet (step 6, open). The kill switches do not stop approval-path publications (see kill-switch.md).

1. Contain: engage the tenant-wide kill switches for the affected tenants; if the suspect path is an API, disable the endpoint by flag or redeploy the previous build.
2. Preserve evidence: audit events (`resourceType`, `actorId`, `correlationId`), request logs by correlation id, the exact build SHA.
3. Determine scope: which procedure/route, which actor, which rows. The cross-tenant harness fixtures are the checklist of entry points; re-run them against the deployed build.
4. Fix: the mandatory-baseline controls are the scoped repository and the policy engine; a leak means one of them was bypassed (raw db access, missing `getById` before use, missing `policy.assert`). Add the regression to the harness, fix, redeploy.
5. Notify: affected tenants per contract; regulator obligations per D-02/D-09.
6. Postmortem within five working days; action items tracked in `incidents`.
