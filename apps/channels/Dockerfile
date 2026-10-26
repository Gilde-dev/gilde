# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/channels/Dockerfile .
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@8.6.2 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/channels/package.json apps/channels/
RUN pnpm install --frozen-lockfile --filter @gilde/channels...
COPY apps/channels apps/channels
RUN pnpm --filter @gilde/channels build \
 && pnpm --filter @gilde/channels deploy --prod /out \
 && cp -r apps/channels/dist /out/dist

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
USER node
CMD ["node", "dist/main.js"]
