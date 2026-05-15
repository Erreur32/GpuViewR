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
# Node 22 on Debian slim. We can't use distroless here because the
# agent invokes rocm-smi when running on AMD hosts, and rocm-smi is
# a Python script (#!/usr/bin/env python3 — symlink to rocm_smi.py
# under /opt/rocm/libexec/). Distroless has no interpreter to host it.
# python3-minimal is ~30 MB and gives us exactly what the script needs.
# Both vendor variants stay served by the same image: NVIDIA agents
# never reach the Python code path and pay nothing for it at runtime.
#
# nvidia-smi still comes from the host via the NVIDIA Container Toolkit
# (`docker run --gpus all`); rocm-smi via a `/opt/rocm` bind-mount —
# see docker-compose.agent.amd.yml.
FROM node:22-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e

WORKDIR /app

# apt-get upgrade picks up the latest OS security patches even when
# the parent tag hasn't been republished — same pattern as the hub
# Dockerfile. python3-minimal is the smallest CPython that can host
# rocm-smi's script without dragging in pip/distutils/setuptools.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends python3-minimal \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R node:node /app

COPY --chown=node:node --from=builder /build/agent/dist/agent.mjs ./agent.mjs
COPY --chown=node:node --from=builder /build/agent/node_modules ./node_modules

ENV NODE_ENV=production

USER node

CMD ["node", "agent.mjs"]
