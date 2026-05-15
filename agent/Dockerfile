# =====================================================
# GpuViewR Agent — small image, single bundled .mjs
# =====================================================
# Build context MUST be the project root, not /agent, so the COPY
# step below can pull in the shared parser from /server/services/:
#   docker build -f agent/Dockerfile -t gpuviewr-agent .

# ---------- Stage 1: bundle ----------
FROM node:22-trixie-slim@sha256:02684a61c3e87ae3e9ec7ef98e312a6ec35483644e204e80fc053648c3e87d75 AS builder

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
# Node 22 on Debian trixie (glibc 2.38). We can't use distroless here
# because the agent invokes rocm-smi when running on AMD hosts, and
# rocm-smi is a Python script (#!/usr/bin/env python3 — symlink to
# rocm_smi.py under /opt/rocm/libexec/). Distroless has no interpreter
# to host it. Full python3 (~+30 MB over python3-minimal) gives us the
# stdlib it needs (json/argparse/subprocess/…).
#
# Why trixie and not bookworm: rocm-smi's native lib librocm_smi64.so.1
# is compiled on the host against the host's glibc. Modern ROCm builds
# require GLIBC_2.38 / GLIBCXX_3.4.32, which bookworm (glibc 2.36)
# can't satisfy. The container loader rejects the bind-mounted lib
# with "version 'GLIBC_2.38' not found" — rocm-smi then exits 0 with
# empty stdout and the agent silently sends nothing. Trixie matches
# Debian 13 hosts where ROCm currently ships.
#
# Both vendor variants stay served by the same image: NVIDIA agents
# never reach the Python code path and pay nothing for it at runtime.
# nvidia-smi still comes from the host via the NVIDIA Container Toolkit
# (`docker run --gpus all`); rocm-smi via a `/opt/rocm` bind-mount —
# see docker-compose.agent.amd.yml.
FROM node:22-trixie-slim@sha256:02684a61c3e87ae3e9ec7ef98e312a6ec35483644e204e80fc053648c3e87d75

WORKDIR /app

# apt-get upgrade picks up the latest OS security patches even when
# the parent tag hasn't been republished — same pattern as the hub
# Dockerfile. We need full python3 (not python3-minimal) because
# rocm-smi imports json/argparse/re/subprocess and friends from the
# stdlib — python3-minimal ships a barebones interpreter for apt
# bootstrap scripts and leaves the whole standard library out.
# libdrm-amdgpu1 silences the "Fail to open libdrm_amdgpu.so" warning
# rocm-smi prints on every invocation — purely cosmetic since the
# script falls through to sysfs, but it pollutes the agent logs.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends python3 tzdata libdrm-amdgpu1 \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R node:node /app

COPY --chown=node:node --from=builder /build/agent/dist/agent.mjs ./agent.mjs
COPY --chown=node:node --from=builder /build/agent/node_modules ./node_modules

ENV NODE_ENV=production

USER node

CMD ["node", "agent.mjs"]
