# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ARG CODEX_VERSION=0.146.0
RUN npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker/bridge-entrypoint.sh /usr/local/bin/bridge-entrypoint

RUN chmod 0755 /usr/local/bin/bridge-entrypoint \
    && mkdir -p /provider-state/claude /provider-state/codex /runtime/codex \
    && ln -s /provider-state/claude /home/node/.claude \
    && ln -s /runtime/codex /home/node/.codex \
    && chown -R node:node /app /runtime

ENV NODE_ENV=production \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8765 \
    CLAUDE_CONFIG_DIR=/provider-state/claude \
    CODEX_HOME=/runtime/codex \
    CODEX_BIN=/usr/local/bin/codex

USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=6s --retries=3 CMD node dist/gateway-daemon.js health

ENTRYPOINT ["/usr/local/bin/bridge-entrypoint"]
CMD ["serve"]
