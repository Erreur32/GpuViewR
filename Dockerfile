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
FROM --platform=$BUILDPLATFORM node:22-trixie-slim@sha256:02684a61c3e87ae3e9ec7ef98e312a6ec35483644e204e80fc053648c3e87d75 AS builder

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
FROM node:22-trixie-slim@sha256:02684a61c3e87ae3e9ec7ef98e312a6ec35483644e204e80fc053648c3e87d75

WORKDIR /app

# Runtime needs:
#  gosu             : drop privileges in entrypoint
#  tzdata           : honor TZ env var
#  python3          : rocm-smi is a Python script under /opt/rocm/libexec/ —
#                     full python3 (not python3-minimal) because the script
#                     imports json/argparse/subprocess from the stdlib.
#                     Adds ~30 MB to the image; NVIDIA users pay for it but
#                     never reach the code path. One image, one tag.
#  libdrm-amdgpu1   : silences the cosmetic "Fail to open libdrm_amdgpu.so"
#                     warning rocm-smi prints on every invocation.
#  We do NOT bundle nvidia-smi: it's mounted/exposed by the NVIDIA container
#  toolkit. rocm-smi comes from a /opt/rocm bind-mount — see
#  docker-compose.amd.yml.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
    gosu \
    tzdata \
    wget \
    ca-certificates \
    python3 \
    libdrm-amdgpu1 \
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

ENV NODE_ENV=production
ENV PORT=3015
ENV DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
 CMD wget -q --spider http://127.0.0.1:${PORT}/api/health || exit 1

EXPOSE 3015

CMD ["node_modules/.bin/tsx", "server/index.ts"]
