# The web client and the API ship as one image on purpose: they are one origin
# in production, which is what lets the client derive its sync URL from
# window.location rather than having it configured (see apps/web/vite.config.ts).
FROM node:22-slim AS build
WORKDIR /app

# Manifests first, so a source-only change does not re-resolve the tree.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY tsconfig.base.json tsconfig.json ./
RUN npm ci

RUN npm --prefix apps/web run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# node:sqlite is built in, so there is no native module to compile here and no
# toolchain in the final image. That is the whole reason store.ts uses it.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/tsconfig.base.json /app/tsconfig.json ./

ENV GALLEY_STATIC=/app/apps/web/dist
ENV GALLEY_DB=/data/galley.db
ENV PORT=8080
EXPOSE 8080

# tsx rather than a compiled bundle: the workspace packages are TypeScript
# source referenced by "*" version, and tsc --build emits a tree that would need
# its own path rewriting to run. Not worth it for a server that starts once.
CMD ["npx", "tsx", "packages/server/src/main.ts"]
