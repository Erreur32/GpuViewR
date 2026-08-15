# ===========================================
# GpuViewR: Node 22 Debian slim (multi-stage)
# ===========================================
# Original gpu-monitor packaging strategy © bigsk1 (MIT)
#   https://github.com/bigsk1/gpu-monitor
# This rewrite uses the same Docker volumes/port for migration compatibility.

# ---------- Stage 1: Build ----------
# Trixie (Debian 13, glibc 2.38) for the runtime stage so a bind-mounted
# /opt/rocm with modern ABI requirements loads cleanly. Builder uses the
# same base to keep native-module compilation environment identical.
FROM --platform=$BUILDPLATFORM node:22-trixie-slim@sha256:8cd0ffd483b64585c6d135364bea5f937ff40cd3da431789af011f9ee8d55af0 AS builder

WORKDIR /app

# Build tools required to compile better-sqlite3 native module.
# We build on glibc to keep runtime compatibility with nvidia-smi (also glibc).
# apt-get upgrade pulls in the latest OS security patches (e.g. zlib CVEs)
# even when the parent node:22-bookworm-slim tag has not been republished yet.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN NO_UPDATE_NOTIFIER=1 npm ci --loglevel=error --no-fund

COPY . .
RUN npm run build

# Bundle the remote agent next to the hub. The hub serves /install.sh
# and /agent.mjs (server/routes/agentDistribution.ts) so a remote
# machine can `curl … | sudo bash` itself in — that path needs
# agent.mjs to exist. Building it here means a single docker compose
# up gives users the curl install for free, no extra step.
RUN npm run build:agent

# Drop devDependencies, keep compiled native binaries
RUN npm prune --production && npm cache clean --force


# ---------- Stage 2: Runtime ----------
FROM node:22-trixie-slim@sha256:8cd0ffd483b64585c6d135364bea5f937ff40cd3da431789af011f9ee8d55af0

WORKDIR /app

# Runtime needs only the strict minimum:
#  gosu             : drop privileges in entrypoint
#  tzdata           : honor TZ env var
#  wget             : healthcheck probe
#  ca-certificates  : outbound HTTPS for update checker
#
# v0.5+ : the hub is vendor-neutral. python3 + libdrm-amdgpu1 (needed
# to run rocm-smi inline pre-v0.5) are gone — local GPU monitoring now
# goes through the sidecar agent in the same compose stack.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    gosu \
    tzdata \
    wget \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data && chown -R node:node /app

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

ENTRYPOINT ["/app/docker-entrypoint.sh"]

COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/server ./server
COPY --chown=node:node --from=builder /app/tsconfig.json ./
COPY --chown=node:node --from=builder /app/CHANGELOG.md ./
COPY --chown=node:node --from=builder /app/README.md ./
# Bundled agent (built in the builder stage above) — required by
# server/routes/agentDistribution.ts for the GET /install.sh + /agent.mjs
# curl install path. Without it those endpoints 503 with a warn log.
COPY --chown=node:node --from=builder /app/agent/dist/agent.mjs ./agent/dist/agent.mjs
COPY --chown=node:node --from=builder /app/agent/install.sh.tpl ./agent/install.sh.tpl
# Windows variant of the agent installer (served at /install.ps1, v0.6.7+).
# Same pattern as install.sh.tpl above: the hub renders __HUB_URL__ on
# each request. Without this COPY the GET /install.ps1 endpoint 503s
# with "# install.ps1 template not found in this build".
COPY --chown=node:node --from=builder /app/agent/install.ps1.tpl ./agent/install.ps1.tpl
# Docker variant of the agent installer (served at /install-agent.sh).
COPY --chown=node:node --from=builder /app/install-agent.sh ./install-agent.sh

ENV NODE_ENV=production
ENV PORT=3015
ENV DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
 CMD wget -q --spider http://127.0.0.1:${PORT}/api/health || exit 1

EXPOSE 3015

CMD ["node_modules/.bin/tsx", "server/index.ts"]
