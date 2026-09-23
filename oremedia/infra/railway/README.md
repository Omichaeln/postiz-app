# Railway deployment (spec 17.1)

Six application services, each with root directory `oremedia` and a config-as-code path under `infra/railway/<service>/railway.json`:

| Service         | Image                             | `OREMEDIA_APP` variable | Ports / health                                                      |
| --------------- | --------------------------------- | ----------------------- | ------------------------------------------------------------------- |
| `api`           | `infra/railway/Dockerfile`        | `api`                   | `PORT` (HTTP), `/health`; runs migrations as its pre-deploy command |
| `worker-core`   | `infra/railway/Dockerfile`        | `worker-core`           | no HTTP; Temporal worker (queues `core`, `agents`, `publish-*`)     |
| `worker-ingest` | `infra/railway/Dockerfile`        | `worker-ingest`         | no HTTP; Temporal worker (`ingest-*`, `listening`, `crm`)           |
| `worker-render` | `infra/railway/Dockerfile.render` | (fixed)                 | no HTTP; Temporal worker (`render`, `media`); Chromium image        |
| `redirector`    | `infra/railway/Dockerfile`        | `redirector`            | `PORT`, `/health`; tracked-link redirects on `LINK_REDIRECT_DOMAIN` |
| `web`           | `infra/railway/Dockerfile.web`    | (fixed)                 | `PORT`; static SPA behind Caddy                                     |

Managed dependencies: Railway MySQL (application), Railway Redis, Cloudflare R2 (object storage, external:
Railway offers no S3-compatible store), and Temporal Cloud (recommended) or the `temporal` service above with its
own Railway MySQL instance. Variables follow Appendix A names exactly; secrets are Railway sealed variables.

The step-by-step procedure, rollback and the kill switches are in `docs/runbooks/deploy-railway.md`.
