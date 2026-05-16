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

# Vendor-aware sanity check. Mirrors the boot-time resolution in
# server/services/activeGpuCollector.ts but at the shell level so the
# operator sees a useful warning BEFORE Node starts. Mock mode skips
# everything — synthetic data doesn't need a real binary.
GPU_VENDOR_VAR=${GPU_VENDOR:-auto}
ROCM_SMI_BIN=${ROCM_SMI_PATH:-/opt/rocm/bin/rocm-smi}

if [ "${MOCK_GPU:-0}" = "1" ]; then
    : # synthetic mode, no check
elif [ "$GPU_VENDOR_VAR" = "nvidia" ]; then
    if ! command -v nvidia-smi >/dev/null 2>&1; then
        echo "WARNING: GPU_VENDOR=nvidia but nvidia-smi not found in PATH."
        echo "  Pass '--gpus all' (or 'runtime: nvidia' in compose) and"
        echo "  install the NVIDIA Container Toolkit on the host."
        echo "  Container will start but the dashboard will show no GPU."
    fi
elif [ "$GPU_VENDOR_VAR" = "amd" ]; then
    if [ ! -x "$ROCM_SMI_BIN" ]; then
        echo "WARNING: GPU_VENDOR=amd but rocm-smi not found at $ROCM_SMI_BIN."
        echo "  Bind-mount /opt/rocm:/opt/rocm:ro from the host (see"
        echo "  docker-compose.amd.yaml). Override ROCM_SMI_PATH if your"
        echo "  ROCm install lives elsewhere."
        echo "  Container will start but the dashboard will show no GPU."
    fi
else
    # auto — probe both. Warn only if neither is reachable.
    if ! command -v nvidia-smi >/dev/null 2>&1 && [ ! -x "$ROCM_SMI_BIN" ]; then
        echo "WARNING: no GPU binary detected (probed nvidia-smi and $ROCM_SMI_BIN)."
        echo "  Set GPU_VENDOR=nvidia or amd explicitly, or run the hub"
        echo "  vendor-neutral as an aggregator for remote agents."
        echo "  Container will start but the dashboard will show no GPU."
    fi
fi

exec gosu node "$@"
