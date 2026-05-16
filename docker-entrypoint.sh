#!/bin/sh
# GpuViewR hub entrypoint.
# Runs as root to fix permissions on /app/data, then drops to the node user.
# v0.5+ : the hub is vendor-neutral — no nvidia-smi / rocm-smi probe here.
# Local GPU monitoring is handled by the sidecar agent in the same compose
# stack (cf. docker-compose.yaml profiles: nvidia / amd).
set -e

NODE_UID=$(id -u node 2>/dev/null || echo "1000")
NODE_GID=$(id -g node 2>/dev/null || echo "1000")

mkdir -p /app/data
chown -R "${NODE_UID}:${NODE_GID}" /app/data 2>/dev/null || true
find /app/data -type d -exec chmod 755 {} \; 2>/dev/null || true
find /app/data -type f -exec chmod 644 {} \; 2>/dev/null || true

exec gosu node "$@"
