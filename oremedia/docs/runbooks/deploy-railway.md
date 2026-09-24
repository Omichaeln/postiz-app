# Runbook: deploy Oremedia on Railway

**Scope:** first provisioning, routine deploys, rollback. **Owner:** platform. **Status of automation:** the
configuration in `infra/railway/` is complete for the services that exist; provisioning needs a Railway account
and cannot be performed from the build environment (no `RAILWAY_TOKEN`). Nothing below has been executed.

## 1. Provision (once per environment: development, staging, production)

1. Create a Railway project per environment. Never share a database or credentials between environments.
2. Add plugins: **MySQL** (application), **Redis**. If self-hosting Temporal, add a **second MySQL** for it.
3. Create a Cloudflare R2 bucket pair (`assets`, `releases`), private, with versioning and lifecycle rules.
4. For each application service: "New service → GitHub repo `omichaeln/postiz-app`", set **Root Directory** to
   `oremedia`, set **Config-as-code path** to `infra/railway/<service>/railway.json`, and set the variables:
   - all services: `DATABASE_URL`, `REDIS_URL`, `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_TLS_CERT_REF`,
     `SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OREMEDIA_APP` (api | worker-core | worker-ingest | redirector);
   - `api`: `AUTH_ISSUER_URL`, `AUTH_CLIENT_ID`, `WEB_ORIGIN`, `REVIEW_PORTAL_ORIGIN`, `KMS_KEY_ID_CREDENTIALS`
     (wrap-only permission), `OBJECT_STORE_*`, `LINK_REDIRECT_DOMAIN`, per-provider `PROVIDER_<KEY>_CLIENT_ID_REF`;
   - `worker-core`: `DATABASE_URL_RETENTION` (step 5: the retention role's user, used only by the retention sweep);
   - `worker-core`, `worker-ingest`: `KMS_KEY_ID_CREDENTIALS` (decrypt permission), `MODEL_ROUTING_POLICY_REF`,
     `ANTHROPIC_API_KEY_REF`, `IMAGE_GEN_PROVIDER`, `OBJECT_STORE_*`, provider secrets `PROVIDER_<KEY>_SECRET_REF`;
   - `worker-render`: `OBJECT_STORE_*` only (no credentials, no model keys);
   - `web`: `VITE_API_ORIGIN`, `VITE_REVIEW_PORTAL_ORIGIN` (build args).
     No variable disables SSRF protection; there is no such flag in the hosted product.
5. Apply the application DB role: replace the placeholders in `packages/db/roles/app-role.sql` and run it as the
   MySQL admin; point `DATABASE_URL` at that user. Apply the retention role the same way with
   `packages/db/roles/retention-role.sql` (a second user, its own password in the secret store) and point
   worker-core's `DATABASE_URL_RETENTION` at it. Both files are generated (`pnpm tsx tooling/scripts/generate-db-roles.ts`)
   and must be re-applied after a migration that adds tables (the app role's grants are per table).
6. Temporal Cloud: create the namespace, upload the client certificate as `TEMPORAL_TLS_CERT_REF`. Self-hosted:
   deploy `infra/railway/temporal` with `MYSQL_SEEDS`, `DB_PORT`, `MYSQL_USER`, `MYSQL_PWD` from the second MySQL.

## 2. Deploy

Railway builds each service from the Dockerfile on push to the configured branch. The `api` service runs
`node dist/migrate.js && node dist/seed-builtin-skills.js` as its pre-deploy command (expand/contract migrations,
forward-safe; then the Release 1 built-in skill packages are registered as platform skills, idempotent by key).
Workers deploy after the API. `worker-ingest` (metric collection, listening, CRM) and `redirector` are provisioned
with Phase 6 and Phase 5 respectively; until their apps exist their `railway.json` files must not be deployed. Artifacts are built once per commit and promoted by environment, never rebuilt per environment.

Rollout order for a change touching workflows: deploy workers with the new workflow version first (old versions
stay registered until in-flight histories drain), then the API that starts the new version.

Rollout order for worker-rendered proposal previews (migration 0002, flag `creative.preview_render`, default off):
a render worker built before previews treats a preview job as an ordinary job, renders the committed base revision
and writes publishable `rendered_exports`. The flag keeps the API from creating preview jobs until every render
worker understands them:

1. Apply migration 0002 (`node dist/migrate.js`, the api pre-deploy command, or run it on its own first): the
   preview-aware `worker-render` reads `render_previews` for every job, so it must not start on the old schema.
   Re-apply `app-role.sql` (step 5): the new tables need their grants.
2. Deploy `worker-render` on the preview-aware build and wait until no instance of the previous build is running
   (Railway → worker-render → Deployments shows only the new one; worker logs show `worker started` from it).
3. Deploy the API (and the other workers) as usual. With the flag still off, `operations.propose` with
   `previewRender` returns the scene preview only and queues nothing.
4. Enable `creative.preview_render` (feature_flags row: tenant allowlist first, then `enabled_default`). To roll back
   `worker-render` to a build without previews, disable the flag first and let queued preview jobs finish.

## 3. Verify

1. `GET https://<api>/health` returns `{ ok: true }`.
2. Worker logs show `worker started` for every task queue.
3. Dashboards: outbox oldest-undispatched age < 60 s; dispatch lateness p99 < 60 s; no `outcome_unknown` growth.

## 4. Rollback

- Railway → service → Deployments → **Redeploy** the previous build (seconds). Schema changes are forward-safe,
  so the previous build runs against the new schema.
- Feature flags are default-off; a misbehaving capability is disabled by flag before any redeploy.
- Kill switches (`operations.killSwitch.set`): `agent_starts` stops new agent runs; `release_dispatch` holds all
  publications at dispatch. Both are per tenant or per brand and audited.
- Public posts cannot be rolled back by reverting code; removal is a separate authorised action.
