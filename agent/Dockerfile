# =====================================================
# GpuViewR Agent — small image, single bundled .mjs
# =====================================================
# Build context MUST be the project root, not /agent, so the COPY
# step below can pull in the shared parser from /server/services/:
#   docker build -f agent/Dockerfile -t gpuviewr-agent .

# ---------- Stage 1: bundle ----------
FROM node:22-bookworm-slim@sha256:9f6d597feaca7d3a5dde341efe65e6f9e62a08bfa1c4d6f5fcefe5a98dabaaa9 AS builder

WORKDIR /build

# Copy only the files needed to bundle.
COPY agent/package.json agent/package-lock.json* ./agent/
# Pre-install deps including dev (esbuild, tsx, typescript).
WORKDIR /build/agent
RUN npm install --no-audit --no-fund --loglevel=error

# Bring in agent sources + the single shared parser file from the hub.
WORKDIR /build
COPY agent/tsconfig.json agent/
COPY agent/src ./agent/src
COPY server/services/_nvidiaParsers.ts ./server/services/_nvidiaParsers.ts

WORKDIR /build/agent
RUN npm run build

# Drop devDependencies so only `ws` survives.
RUN npm prune --production && npm cache clean --force


# ---------- Stage 2: runtime ----------
# distroless does NOT ship nvidia-smi — that comes from the host via
# the NVIDIA Container Toolkit at `docker run --gpus all` time.
FROM gcr.io/distroless/nodejs22-debian12@sha256:3c4d2e34b59a3a14b9bbfcfe9c20e25f0a13e87bb4569cdc3a6ae8c5ec1e3a98

WORKDIR /app

COPY --from=builder /build/agent/dist/agent.mjs ./agent.mjs
COPY --from=builder /build/agent/node_modules ./node_modules

ENV NODE_ENV=production

CMD ["agent.mjs"]
