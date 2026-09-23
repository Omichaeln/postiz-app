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
   - `worker-core`, `worker-ingest`: `KMS_KEY_ID_CREDENTIALS` (decrypt permission), `MODEL_ROUTING_POLICY_REF`,
     `ANTHROPIC_API_KEY_REF`, `IMAGE_GEN_PROVIDER`, `OBJECT_STORE_*`, provider secrets `PROVIDER_<KEY>_SECRET_REF`;
   - `worker-render`: `OBJECT_STORE_*` only (no credentials, no model keys);
   - `web`: `VITE_API_ORIGIN`, `VITE_REVIEW_PORTAL_ORIGIN` (build args).
     No variable disables SSRF protection; there is no such flag in the hosted product.
5. Apply the application DB role: replace the placeholders in `packages/db/roles/app-role.sql` and run it as the
   MySQL admin; point `DATABASE_URL` at that user.
6. Temporal Cloud: create the namespace, upload the client certificate as `TEMPORAL_TLS_CERT_REF`. Self-hosted:
   deploy `infra/railway/temporal` with `MYSQL_SEEDS`, `DB_PORT`, `MYSQL_USER`, `MYSQL_PWD` from the second MySQL.

## 2. Deploy

Railway builds each service from the Dockerfile on push to the configured branch. The `api` service runs
`node dist/migrate.js` as its pre-deploy command (expand/contract migrations, forward-safe). Workers deploy after
the API. Artifacts are built once per commit and promoted by environment, never rebuilt per environment.

Rollout order for a change touching workflows: deploy workers with the new workflow version first (old versions
stay registered until in-flight histories drain), then the API that starts the new version.

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
