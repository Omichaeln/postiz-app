# Workflow replay tests (spec 19.4)

Every deployed workflow type has recorded histories under `tooling/test-fixtures/histories/<workflow>/<version>/`
replayed here with `Worker.runReplayHistories`. Histories are recorded against a Temporal dev server; this
environment cannot download the time-skipping test server (GitHub releases are blocked by the proxy), so the
first histories are recorded in CI or on a developer machine and committed.
