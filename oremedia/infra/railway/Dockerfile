# Oremedia Node service image (api, worker-core, worker-ingest, redirector). Parameterised by OREMEDIA_APP.
# Railway passes service variables as build args; set OREMEDIA_APP on each service (spec 17.1 deployment).
# syntax=docker/dockerfile:1.7
FROM node:22.12.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.6.1 --activate

FROM base AS build
ARG OREMEDIA_APP=api
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc turbo.json tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY tooling ./tooling
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @oremedia/${OREMEDIA_APP} build
# A flattened production install for exactly this app (workspace packages are bundled by tsup; third-party deps come from here).
RUN pnpm --filter @oremedia/${OREMEDIA_APP} deploy --prod --legacy /out

FROM base AS runtime
ARG OREMEDIA_APP=api
ENV NODE_ENV=production OREMEDIA_SERVICE=oremedia-${OREMEDIA_APP}
RUN groupadd -r oremedia && useradd -r -g oremedia -d /app oremedia
WORKDIR /app
COPY --from=build --chown=oremedia:oremedia /out/dist ./dist
COPY --from=build --chown=oremedia:oremedia /out/node_modules ./node_modules
COPY --from=build --chown=oremedia:oremedia /out/package.json ./package.json
USER oremedia
ENV OREMEDIA_MIGRATIONS_DIR=/app/dist/migrations
CMD ["node", "dist/main.js"]
