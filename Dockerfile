# ===========================================
# GpuViewR: Node 22 Debian slim (multi-stage)
# ===========================================
# Original gpu-monitor packaging strategy © bigsk1 (MIT)
#   https://github.com/bigsk1/gpu-monitor
# This rewrite uses the same Docker volumes/port for migration compatibility.

# ---------- Stage 1: Build ----------
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder

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

# Drop devDependencies, keep compiled native binaries
RUN npm prune --production && npm cache clean --force


# ---------- Stage 2: Runtime ----------
FROM node:22-bookworm-slim

WORKDIR /app

# Runtime needs:
#  gosu    : drop privileges in entrypoint
#  tzdata  : honor TZ env var
#  We do NOT bundle nvidia-smi: it's mounted/exposed by the NVIDIA container toolkit.
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

ENV NODE_ENV=production
ENV PORT=3015
ENV DATA_DIR=/app/data

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
 CMD wget -q --spider http://127.0.0.1:${PORT}/api/health || exit 1

EXPOSE 3015

CMD ["node_modules/.bin/tsx", "server/index.ts"]
