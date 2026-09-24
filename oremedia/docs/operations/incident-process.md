# Incident process (spec 18, 17.7; ledger 7.15)

Status: written for the pilot. Paging tooling, the on-call rota and the named people are **not configured yet**
(open items in `production-readiness.md`); the roles below are role names until the pilot's owners are named.

## 1. Kill switch first

When a publication may be wrong, unauthorised or duplicated, stop the effect before diagnosing it:

1. `operations.killSwitch.set { scope: 'release_dispatch', brandId | null, engaged: true, reason }` stops the
   **mandate (autonomous) path** at dispatch: due publications are held with `kill_switch_off`, never dropped.
   Approval-path publications are **not** stopped by it (spec 13.4 scopes it to autonomous publication; verified by
   `runbooks.integration.test.ts`, "kill switch (7.7)"). To stop approval-path posts for a brand or tenant, cancel
   the scheduled rows (`publishing.publications.cancel`) or, platform-wide for one provider, stop that provider's
   `publish-<providerKey>` activity worker (its publications wait on the queue; nothing is sent).
2. `scope: 'agent_starts'` stops new agent runs; running runs finish or hit their deadline.
3. A misbehaving capability is switched off by its feature flag before any redeploy; a bad deploy is rolled back
   (Railway redeploy of the previous build, `docs/runbooks/deploy-railway.md` §4).

Every engage and release is audited with the reason (`kill_switch.engage` / `kill_switch.release`). Held
publications are never auto-released; a person re-releases each one.

## 2. Severities

| Severity | Definition                                                                                                                                           | Examples                                                                                                                   | Response                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| sev1     | Data of one tenant visible to another; a publication released without a valid approval or mandate; secrets exposed; a duplicate public post at scale | Suspected cross-tenant exposure; approval consistency < 100 %; credential leak                                             | Page immediately, 24/7; IC within 15 min                 |
| sev2     | Publishing broken or late for many tenants; SLO fast-burn; data loss risk                                                                            | Dispatch lateness p99 > 60 s at top of hour; outbox dispatched = 0 with a backlog; `outcome_unknown` growing; API 5xx burn | Page in business hours + pilot windows; IC within 30 min |
| sev3     | One journey degraded, workaround exists; one tenant or one provider affected                                                                         | Render failures above budget; a provider's rate limits; a channel needing reconnect across a brand                         | Ticket, same business day                                |
| sev4     | Cosmetic, or a single-object issue with a runbook                                                                                                    | One held publication; one dead letter with a disposition                                                                   | Ticket, next sprint                                      |

Anything touching tenant isolation, approval binding, credentials or duplicate publication starts at sev1 and is
downgraded only with evidence.

## 3. Paging

- Alerts come from the SLO dashboard queries (`docs/operations/slos.md`); every alert names its runbook.
- Page: sev1 always; sev2 during business hours and during announced pilot publishing windows (the top-of-hour
  bursts). Tickets otherwise.
- Channel: the pilot's paging tool (to be chosen, open) → primary on-call (Platform on-call role) → secondary after
  10 minutes → engineering lead after 20 minutes.
- Tenant-facing reports (a customer says "my post went out twice") are triaged by Support into the same flow; a
  support session (spec 5.7, reason + time box, audited) is required before looking at tenant data.

## 4. Roles

| Role                    | Who (pilot)                                          | Does                                                                                                        |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Incident commander (IC) | Platform on-call (first responder) until handed over | Owns the incident, declares severity, decides containment (kill switch, flag, rollback), keeps the timeline |
| Operations              | Platform engineer                                    | Runs the runbooks, collects evidence (audit by correlation id, build SHA, worker logs)                      |
| Communications          | Engineering lead or product owner                    | Internal updates, tenant notices, regulator notices via Security lead                                       |
| Security lead           | Named security owner                                 | Mandatory for sev1 isolation/credential incidents; decides notifications under D-02 / D-09                  |
| Tenant contact          | Account owner of the affected tenant                 | Confirms impact, re-releases held publications for their brands                                             |

## 5. Runbook → severity map

| Runbook                                                                                                        | Default severity                                          | Escalate to                                             |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| [Suspected cross-tenant exposure](../runbooks/suspected-cross-tenant-exposure.md)                              | sev1                                                      | —                                                       |
| [Revoke a compromised credential, API client, skill or template](../runbooks/revoke-compromised-credential.md) | sev1 (platform secret) / sev2 (one tenant's token or key) | sev1 if used after the suspected exposure               |
| [Engage the kill switch](../runbooks/kill-switch.md)                                                           | sev2                                                      | sev1 if a publication went out without valid authority  |
| [Reconcile an outcome_unknown publication](../runbooks/reconcile-outcome-unknown.md)                           | sev4 (one) / sev2 (many)                                  | sev1 on a confirmed duplicate public post at scale      |
| [Drain and replay the outbox and dead letters](../runbooks/outbox-drain-and-replay.md)                         | sev2 at top of hour / sev3 otherwise                      | sev1 if publications are missed at scale                |
| [Handle partial multi-channel success](../runbooks/partial-multichannel-success.md)                            | sev4                                                      | sev3 across a brand                                     |
| [Reconnect a channel](../runbooks/reconnect-a-channel.md)                                                      | sev4 (one) / sev3 (brand)                                 | sev2 when a provider app is suspended (all connections) |
| [Recover rendering](../runbooks/recover-rendering.md)                                                          | sev3                                                      | sev2 when publishing waits on renders                   |
| [Restore a single tenant](../runbooks/restore-single-tenant.md)                                                | sev2                                                      | sev1 when restored data could republish                 |
| [Roll back a workflow version safely](../runbooks/rollback-workflow-version.md)                                | sev2                                                      | sev1 on non-determinism failing in-flight publications  |
| [Process a deletion request](../runbooks/process-deletion-request.md)                                          | sev4 (routine)                                            | sev2 when a legal deadline is at risk                   |

## 6. Communication templates

**Internal declaration (IC, within 15 min for sev1):**

> [SEV{n}] {one-line summary}. Started {UTC time}. Impact: {tenants / brands / journeys}. Containment: {kill switch
> scope / flag / rollback / none yet}. IC: {name}. Next update: {UTC time}. Correlation ids: {ids}. Runbook: {link}.

**Tenant notice (Communications, after the Security lead's go for sev1):**

> Subject: {Service} incident affecting {brand}: {status}
>
> On {date} between {start} and {end} UTC, {what happened, in plain words}. {Your publications X were held / were
> published late / may have been visible to …}. We have {containment}. Posts that were held stay held until you
> re-release them in the calendar. {What you need to do, if anything}. We will send the incident review by
> {date}. Contact: {name, address}.

**Resolution:**

> [SEV{n} RESOLVED] {summary}. Resolved {UTC}. Root cause (preliminary): {…}. Follow-ups: {tickets}. Postmortem due
> {date} (five working days).

## 7. Postmortem (within five working days for sev1/sev2; blameless)

Record the incident in `incidents` (severity, title, summary, state open → mitigated → resolved → postmortem_done).
**Open:** there is no `operations.incidents` API procedure yet; until it exists the IC records it through a support
session and the postmortem document.

```
Title / severity / IC / dates (detected, contained, resolved)
Impact: tenants, brands, publications (ids), data exposed (classes), SLO budget consumed
Timeline (UTC): detection → declaration → containment → resolution, with correlation ids
Root cause: the control that failed (scoped repository, policy check, approval binding, outbox, provider)
What went well / what did not (detection time, runbook accuracy, paging)
Action items: owner (role), due date, ticket; add the regression to the relevant harness or rehearsal test
Runbook changes: which runbook step was wrong or missing (update its "Exercised" line)
```

## 8. After every incident

- Re-run the affected rehearsal test (`apps/worker-core/src/runbooks.integration.test.ts`) and the cross-tenant
  harness (`pnpm test:cross-tenant`) against the fix before release.
- Release every kill switch deliberately, with a reason; confirm held publications with their tenants.
