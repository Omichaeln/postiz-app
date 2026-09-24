# Oremedia Node service image (api, worker-core, worker-ingest, redirector). Parameterised by OREMEDIA_APP.
# Railway passes service variables as build args; set OREMEDIA_APP on each service (spec 17.1 deployment).
# syntax=docker/dockerfile:1.7
FROM node:22.22.2-bookworm-slim AS base
# OS security updates at build time so the container scan (spec 2.1.12) judges the patched image, not the tag's snapshot.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

FROM base AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
# pnpm is installed from the registry (npm verifies integrity); corepack in this Node image carries a rotated-out signing key.
RUN npm install -g pnpm@10.6.1 && npm cache clean --force
ARG OREMEDIA_APP=api
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY tooling ./tooling
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# tsup inlines the workspace packages and leaves every third-party package external (apps/*/tsup.config.ts).
RUN pnpm --filter @oremedia/${OREMEDIA_APP} build
# Flat production dependency tree for this app and the workspace packages inlined into it, so the bundle resolves
# their third-party imports from one node_modules. (`pnpm deploy` is not used: it fails on the `catalog:` specs that
# @trpc/server publishes in its devDependencies.)
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules packages/modules/*/node_modules tooling/*/node_modules \
  && pnpm install --prod --frozen-lockfile --filter "@oremedia/${OREMEDIA_APP}..." --config.node-linker=hoisted

FROM base AS runtime
ARG OREMEDIA_APP=api
ENV NODE_ENV=production OREMEDIA_SERVICE=oremedia-${OREMEDIA_APP}
RUN groupadd -r oremedia && useradd -r -g oremedia -d /app oremedia \
  # The runtime never installs packages: npm and corepack are removed (least privilege; their bundled
  # dependencies are what the container scan otherwise flags).
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=build --chown=oremedia:oremedia /src/node_modules ./node_modules
COPY --from=build --chown=oremedia:oremedia /src/apps/${OREMEDIA_APP}/dist ./dist
COPY --from=build --chown=oremedia:oremedia /src/apps/${OREMEDIA_APP}/package.json ./package.json
USER oremedia
ENV OREMEDIA_MIGRATIONS_DIR=/app/dist/migrations
CMD ["node", "dist/main.js"]
