# Runbook: recover rendering

**Symptom:** `render_jobs` stuck in `rendering`/`failed`; metric `oremedia.render.failures` rising; p95 render duration > 15 s.
**Owner:** platform on-call. **Exercised:** not yet (Phase 3).

1. Check `worker-render` health (Railway service logs): Chromium launch failures, memory limits, missing fonts.
2. A failed job carries `error`; common causes: font asset not readable (object store credentials), renderer version mismatch (deploy skew between web and worker: the manifest records `rendererVersion`), oversized document.
3. Retry: `creative.renders.request` for the revision (creates a new job; exports are immutable and never overwritten). Retry is safe: exports are keyed by revision + format + renderer version.
4. If many jobs fail after a deploy: roll back `worker-render` to the previous image (Railway redeploy) and keep the API; renders resume with the previous renderer version.
5. Verify: golden-render suite passes in CI for the deployed renderer version; failures metric returns to baseline.
