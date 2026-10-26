# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@8.6.2 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/channels/package.json apps/channels/
RUN pnpm install --frozen-lockfile --filter @gilde/api...
COPY apps/api apps/api
RUN pnpm --filter @gilde/api build \
 && pnpm --filter @gilde/api deploy --prod /out \
 && cp -r apps/api/dist /out/dist

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/workspace && chown -R node:node /data
WORKDIR /app
ENV NODE_ENV=production PORT=4100 GILDE_WORKSPACE_DIR=/data/workspace AGENT_INSTRUCTIONS_PATH=/app/docs/agent-instructions.md
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/dist ./dist
COPY --chown=node:node docs/agent-instructions.md ./docs/agent-instructions.md
USER node
EXPOSE 4100
VOLUME /data/workspace
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
