# syntax=docker/dockerfile:1
# M1: in-repo image for running the tool on Linux/CI. See docs/docker.md for
# host CLIs, volumes, and scheduling (container does not replace host systemd in
# typical setups).
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
# Compile only: runtime needs dist/; node_modules is not required to execute
# (all imports are node:*). Tests are not shipped in the final stage.
RUN npm run build && rm -rf dist/test

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/src/ai-limit-timer.js"]
CMD ["status"]
