#!/bin/sh
# GpuViewR: entrypoint
# Runs as root to fix permissions on /app/data, then drops to the node user.
set -e

NODE_UID=$(id -u node 2>/dev/null || echo "1000")
NODE_GID=$(id -g node 2>/dev/null || echo "1000")

# Ensure data dir exists and is writable by the node user
mkdir -p /app/data
chown -R "${NODE_UID}:${NODE_GID}" /app/data 2>/dev/null || true
find /app/data -type d -exec chmod 755 {} \; 2>/dev/null || true
find /app/data -type f -exec chmod 644 {} \; 2>/dev/null || true

# Sanity check: nvidia-smi must be reachable.
# (Provided by the NVIDIA container toolkit when --runtime=nvidia is used.)
if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "WARNING: nvidia-smi not found in PATH."
    echo "  Make sure docker-compose has 'runtime: nvidia' and the NVIDIA"
    echo "  Container Toolkit is installed on the host."
    echo "  Container will start but the dashboard will show no GPU."
fi

exec gosu node "$@"

