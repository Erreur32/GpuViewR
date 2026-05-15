# =====================================================
# GpuViewR Agent — small image, single bundled .mjs
# =====================================================
# Build context MUST be the project root, not /agent, so the COPY
# step below can pull in the shared parser from /server/services/:
#   docker build -f agent/Dockerfile -t gpuviewr-agent .

# ---------- Stage 1: bundle ----------
FROM node:22-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS builder

WORKDIR /build

# Copy only the files needed to bundle.
COPY agent/package.json agent/package-lock.json ./agent/
# Pre-install deps including dev (esbuild, tsx, typescript).
# `npm ci` is reproducible from the lockfile — Scorecard "Pinned-
# Dependencies" wants exact versions, not floating ranges, and `ci`
# guarantees that without a manual SHA list.
WORKDIR /build/agent
RUN npm ci --no-audit --no-fund --loglevel=error

# Bring in agent sources + the shared parser files from the hub. The
# agent collectors import both _nvidiaParsers.ts (CSV from nvidia-smi)
# and _rocmParsers.ts (JSON from rocm-smi); esbuild bundles whichever
# the active collector pulls in at runtime.
WORKDIR /build
COPY agent/tsconfig.json agent/
COPY agent/src ./agent/src
COPY server/services/_nvidiaParsers.ts ./server/services/_nvidiaParsers.ts
COPY server/services/_rocmParsers.ts ./server/services/_rocmParsers.ts

WORKDIR /build/agent
RUN npm run build

# Drop devDependencies so only `ws` survives.
RUN npm prune --production && npm cache clean --force


# ---------- Stage 2: runtime ----------
# distroless ships no smi binary — nvidia-smi comes from the host via
# the NVIDIA Container Toolkit (`docker run --gpus all`), and rocm-smi
# via a bind-mount (see docker-compose.agent.amd.yml).
FROM gcr.io/distroless/nodejs22-debian12@sha256:8a3e96fe3345b5d83ecec2066e7c498139a02a6d1214e4f6c39f9ce359f3f5bc

WORKDIR /app

COPY --from=builder /build/agent/dist/agent.mjs ./agent.mjs
COPY --from=builder /build/agent/node_modules ./node_modules

ENV NODE_ENV=production

CMD ["agent.mjs"]
