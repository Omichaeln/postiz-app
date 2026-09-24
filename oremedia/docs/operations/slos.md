# SLOs and dashboards (spec 17.2, 17.3; ledger 7.14)

Every journey answers four questions: **up** (is it doing work at all), **fast** (latency against the target),
**erroring** (bad outcomes over all outcomes) and **keeping up** (is work waiting longer than it should). Every
metric below is a name in `packages/observability/src/telemetry.ts` (`METRIC`); the dashboard
`infra/observability/dashboards/oremedia-slos.json` is built from exactly these names, and
`packages/observability/src/telemetry.test.ts` fails if either file names a metric `METRIC` does not define.
Targets are the spec 17.2 starting values, **placeholders until the pilot measures real traffic**.

Names are OpenTelemetry instrument names. The OTLP → Prometheus path renders `oremedia.outbox.dispatch_lag_ms` as
`oremedia_outbox_dispatch_lag_ms_bucket` / `_sum` / `_count` (histograms) and counters with a `_total` suffix; the
dashboard's PromQL uses those forms and carries the OpenTelemetry name in `oremediaMetric` per target.

| Instrument kind | Names                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Counter         | `oremedia.http.requests` {status, path}, `oremedia.outbox.dispatched` {eventType, routed}, `oremedia.outbox.dispatch_failures`, `oremedia.publish.outcomes` {outcome}, `oremedia.publish.outcome_unknown`, `oremedia.render.jobs` {result}, `oremedia.render.failures` {reason}, `oremedia.agents.runs` {state, taskKind}, `oremedia.channels.token_refresh_failures`, `oremedia.channels.reconnect_needed`, `oremedia.providers.rate_limit_hits`, `oremedia.policy.denials`      |
| Histogram       | `oremedia.render.start_lag_ms`, `oremedia.agents.run_start_lag_ms` {taskKind}, `oremedia.http.duration_ms` {path}, `oremedia.publish.dispatch_lateness_ms` {providerKey}, `oremedia.outbox.dispatch_lag_ms` {eventType}, `oremedia.render.duration_ms` {formatKey}, `oremedia.agents.run_duration_ms` {state, taskKind}, `oremedia.agents.run_cost_micros` {state, taskKind}, `oremedia.measurement.ingest_lag_ms` {outcome}, `oremedia.agents.spend_vs_reservation_drift_micros` |
| Gauge           | `oremedia.outbox.oldest_undispatched_age_ms`, `oremedia.outbox.dead_letters` (worker-core, platform-wide)                                                                                                                                                                                                                                                                                                                                                                         |

## Schedule (publishing.publications.schedule; the edit-and-save budget applied to the schedule command)

| Question   | Indicator                                                                                                                    | Threshold (spec 17.2)                  | Alert → runbook                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------- |
| Up         | `oremedia.http.requests` rate with `path="/trpc/publishing.publications.schedule"` > 0 during working hours; `/health` probe | probe fails 3× in 1 min                | Page (sev2) → deploy-railway (rollback) |
| Fast       | `oremedia.http.duration_ms` p95 for that path                                                                                | p95 < 400 ms                           | Ticket at 2× for 15 min                 |
| Erroring   | `oremedia.http.requests` {path, status ≥ 500} / {path}                                                                       | ≥ 99.9 % non-5xx (RATE_LIMITED is 429) | Page when burn rate > 14× over 1 h      |
| Keeping up | `oremedia.outbox.oldest_undispatched_age_ms`                                                                                 | < 60 s                                 | Page (sev2) → outbox-drain-and-replay   |

## Dispatch (outbox → publicationWorkflowV1 → provider call)

| Question   | Indicator                                                                                                                     | Threshold (spec 17.2)                                                                  | Alert → runbook                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Up         | `oremedia.outbox.dispatched` rate > 0 whenever `oremedia.outbox.oldest_undispatched_age_ms` > 0                               | dispatched = 0 for 5 min with a backlog                                                | Page (sev1 at top of hour) → outbox-drain-and-replay                             |
| Fast       | `oremedia.publish.dispatch_lateness_ms` p99 (claim − scheduled time, by providerKey)                                          | p99 < 60 s                                                                             | Page (sev2) → outbox-drain-and-replay, then provider queues                      |
| Erroring   | `oremedia.publish.outcomes` {outcome ∈ failed, outcome_unknown, held} / all outcomes; `oremedia.publish.outcome_unknown` rate | 99 % reach published or definitive failed within 1 h; any outcome_unknown growth pages | Page → reconcile-outcome-unknown; held spike → kill-switch / reconnect-a-channel |
| Keeping up | `oremedia.outbox.dispatch_lag_ms` p99 (event ready → workflow start requested); `oremedia.outbox.dead_letters`                | p99 < 60 s; dead letters = 0                                                           | Page → outbox-drain-and-replay                                                   |

Approval consistency (spec 17.2: 100 %, any miss is an incident) is enforced, not sampled: dispatch re-runs the
release policy (`publication.release_check` audit events, `decision = denied` with the failed checks) and holds;
the audit query is the indicator until a dedicated counter exists (open, see production-readiness).

## Render (creative.renders.request → renderJobWorkflowV1 on `render`)

| Question   | Indicator                                                                            | Threshold (spec 17.2)                    | Alert → runbook                              |
| ---------- | ------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------- |
| Up         | `oremedia.render.jobs` rate > 0 while jobs are requested                             | no finished job for 15 min with requests | Page (sev3) → recover-rendering              |
| Fast       | `oremedia.render.duration_ms` p95 per page, by formatKey                             | p95 < 15 s                               | Ticket → recover-rendering (step 4 rollback) |
| Erroring   | `oremedia.render.jobs` {result="failed"} / all; `oremedia.render.failures` by reason | ≥ 99.5 % succeed                         | Page on burn → recover-rendering             |
| Keeping up | `oremedia.render.start_lag_ms` p95 (job requested → first start on worker-render)    | < 30 s (placeholder)                     | Ticket → recover-rendering (step 1)          |

## Agent run (agent.run_requested → agentRunWorkflowV1 on `agents`)

| Question   | Indicator                                                                                                                   | Threshold (spec 17.2)                                | Alert → runbook                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| Up         | `oremedia.agents.runs` rate > 0 while runs are requested                                                                    | none finished for 30 min with requests               | Ticket → kill-switch (agent_starts)      |
| Fast       | `oremedia.agents.run_duration_ms` p95 by taskKind                                                                           | below the run deadline (30 min); target set at pilot | Ticket                                   |
| Erroring   | `oremedia.agents.runs` {state ∈ failed} / all terminal (policy_denied and budget_exhausted are outcomes, not system errors) | ≥ 99 % complete without system error                 | Page on burn (sev3)                      |
| Cost       | `oremedia.agents.run_cost_micros` sum by taskKind; `oremedia.agents.spend_vs_reservation_drift_micros`                      | drift 0 (any positive drift is an overspend)         | Page (sev2) → kill-switch (agent_starts) |
| Keeping up | `oremedia.agents.run_start_lag_ms` p95 by taskKind (run requested → started on `agents`)                                    | < 60 s (placeholder)                                 | Ticket → kill-switch (agent_starts)      |

## Ingest (measurement.collection_due → metricCollectionWorkflowV1 on `ingest-metrics`)

| Question   | Indicator                                                                                                              | Threshold (spec 17.2)                                  | Alert → runbook                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------ |
| Up         | `oremedia.measurement.ingest_lag_ms` count rate > 0                                                                    | no pull for 2 h with published posts                   | Ticket → reconnect-a-channel         |
| Fast       | `oremedia.measurement.ingest_lag_ms` p95 (window end → pull finished)                                                  | < capability latency × 2 (analytics freshness 95 %)    | Ticket                               |
| Erroring   | `oremedia.providers.rate_limit_hits`, `oremedia.channels.token_refresh_failures`, `oremedia.channels.reconnect_needed` | rate-limit hits sustained 30 min; any reconnect_needed | Ticket → reconnect-a-channel         |
| Keeping up | `oremedia.measurement.ingest_lag_ms` p99; `oremedia.measurement.stale_share` is declared, not emitted                  | p99 < 2 × latency                                      | **Open**: stale share needs emission |

## Declared but not emitted (open)

`oremedia.temporal.schedule_to_start_ms` (needs the Temporal worker's runtime metrics wired to OTel),
`oremedia.publish.outcome_unknown_age_ms`, `oremedia.publish.duplicate_detections`,
`oremedia.review.approval_invalidations`, `oremedia.measurement.stale_share`. They are not on the dashboard.

## Where each metric is emitted and what proves it

| Metric                                                                                       | Emitted in                                                                                 | Verified by                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `oremedia.outbox.dispatch_lag_ms`                                                            | `packages/modules/operations/src/outbox-dispatcher.ts`                                     | `outbox-dispatcher.integration.test.ts` (fairness case)                                         |
| `oremedia.publish.outcomes`                                                                  | `packages/modules/publishing/src/runtime.ts` (mark*/hold)                                  | `apps/worker-core/src/runbooks.integration.test.ts` (published, failed, outcome_unknown)        |
| `oremedia.render.duration_ms`, `oremedia.render.jobs`, `oremedia.render.failures`            | `packages/activities/src/render-job.ts`                                                    | `apps/worker-render/src/recover-rendering.integration.test.ts`                                  |
| `oremedia.render.start_lag_ms`                                                               | `packages/modules/creative/src/service.ts` (renders.markRendering)                         | `apps/worker-render/src/recover-rendering.integration.test.ts`                                  |
| `oremedia.agents.run_start_lag_ms`                                                           | `packages/modules/agents/src/runtime.ts` (resolveContextSnapshot)                          | `packages/modules/agents/src/agents.integration.test.ts`                                        |
| `oremedia.agents.runs`, `oremedia.agents.run_duration_ms`, `oremedia.agents.run_cost_micros` | `packages/modules/agents/src/runtime.ts` (finishRun)                                       | `packages/modules/agents/src/agents.integration.test.ts` (completed run: state, duration, cost) |
| `oremedia.measurement.ingest_lag_ms`                                                         | `packages/activities/src/metric-collection.ts`                                             | `packages/activities/src/metric-collection.test.ts`                                             |
| `oremedia.http.requests` {path}                                                              | `apps/api/src/server.ts`                                                                   | instrument shape: `packages/observability/src/telemetry.test.ts`                                |
| Everything above reaching a collector                                                        | `packages/observability/src/bootstrap.ts` (OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set) | **Needs a live environment**: no collector here                                                 |
