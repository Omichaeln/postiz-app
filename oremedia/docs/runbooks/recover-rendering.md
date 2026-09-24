# Runbook: recover rendering

**Symptom:** `render_jobs` stuck in `rendering`/`failed`; metric `oremedia.render.failures` rising; p95 render duration > 15 s.
**Owner:** platform on-call. **Exercised:** locally by `apps/worker-render/src/recover-rendering.integration.test.ts` (real creative module and render activities, a scripted renderer in place of Chromium): a renderer crash fails the job with `render_failed: <detail>` and counts `oremedia.render.failures`; the retry (step 3) is a new job whose export lands under its own job key while the failed job stays untouched; a duplicate start of the finished job is `illegal_state` and changes nothing. **Needs a live environment for:** Chromium itself (no `OREMEDIA_CHROMIUM_PATH` here), the Railway logs and image rollback (steps 1 and 4), the Temporal UI check and the golden-render suite (step 5).

1. Check `worker-render` health (Railway service logs, service `oremedia-worker-render`): a container that exits with
   `DATABASE_URL is required` / `TEMPORAL_ADDRESS is required` is misconfigured; `workflow bundle missing` or
   `renderer bundle not found` means the image was built without `pnpm --filter @oremedia/editor build:renderer`
   before `pnpm --filter @oremedia/worker-render build`; `chromium launched` should appear on the first render.
2. A failed job carries `error` as `<reason>: <detail>` (`RenderFailureReason` in `packages/contracts/src/render.ts`):
   `rights_ineligible` (an asset lost its rights or approval: fix the asset, then re-request), `not_found` /
   `policy_denied` (the requester lost access), `export_integrity` (object store returned bytes that do not hash as
   rendered: check the bucket, never re-use the object), `render_failed` (Chromium: memory, timeout
   `RENDER_TIMEOUT_MS`, an oversized document), `storage_failed`, `illegal_state` (a duplicate start of a finished job;
   harmless). Renderer version skew between web and worker shows in `rendered_exports.renderer_version` and the
   manifest; the worker refuses a bundle whose version differs from its own.
3. Retry: `creative.renders.request` for the revision (creates a new job; exports are immutable and never
   overwritten: each export is stored under `assets/<tenant>/<brand>/exports/<revision>/<job>/<page>-<format>.png`).
   A job stuck in `rendering` after a worker crash is finished by Temporal's retry of the workflow
   `render:<renderJobId>` on task queue `render`; check it in the Temporal UI before re-requesting.
4. If many jobs fail after a deploy: roll back `worker-render` to the previous image (Railway redeploy) and keep the
   API; renders resume with the previous renderer version.
5. Verify: the golden-render suite passes for the deployed renderer version
   (`OREMEDIA_CHROMIUM_PATH=<chromium> pnpm exec vitest run --project integration apps/worker-render`; an intended
   pixel change is committed with `OREMEDIA_UPDATE_GOLDENS=1` and a `RENDERER_VERSION` bump in
   `packages/editor/src/renderer/version.ts`); failures metric returns to baseline.
