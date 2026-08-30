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
# agent collectors import both parsers/nvidia.ts (CSV from nvidia-smi)
# and parsers/rocm.ts (JSON from rocm-smi); esbuild bundles whichever
# the active collector pulls in at runtime.
WORKDIR /build
COPY agent/tsconfig.json agent/
COPY agent/src ./agent/src
COPY agent/scripts ./agent/scripts
COPY server/services/parsers ./server/services/parsers

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
# procps gives us `ps`, which rocm-smi's --showpids shells out to in
# order to translate PIDs into process names. Without it the script
# logs `ps: not found` on stderr and reports `process_name="unknown"`
# for every GPU pid (observed v0.7.0 on the .210 AMD master — see the
# CHANGELOG entry for v0.7.1). Our own collector's resolveProcessName
# fallback covers the gap when /proc is mounted, but installing procps
# fixes the issue at its source and the user sees real names even when
# the /host/proc bind-mount is missing.
# libcap2-bin gives us setcap, used right below.
RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends python3 tzdata libdrm-amdgpu1 procps libcap2-bin \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R node:node /app

COPY --chown=node:node --from=builder /build/agent/dist/agent.mjs ./agent.mjs
COPY --chown=node:node --from=builder /build/agent/node_modules ./node_modules

ENV NODE_ENV=production

# `cap_add: [SYS_PTRACE]` in compose only lands the capability in this
# container's bounding set — it never reaches a non-root process's
# effective/permitted set on its own (no ambient caps by default), so
# `USER node` below would otherwise leave ptrace-gated reads (like
# /proc/<pid>/fdinfo, used by processesAmdgpuFdinfo.ts) failing with
# EACCES even though `docker inspect` shows the capability granted.
# A file capability sidesteps that: it's promoted from the bounding
# set into the process's effective set at exec() time regardless of
# the calling UID, so `node` keeps CAP_SYS_PTRACE without running as
# root. Must run as root (before `USER node`) since setcap needs
# CAP_SETFCAP on the target file.
RUN setcap cap_sys_ptrace=+eip /usr/local/bin/node

USER node

CMD ["node", "agent.mjs"]
