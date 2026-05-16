#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# GpuViewR — remote agent install (Docker variant)
#
# One-liner displayed by the hub UI's Add Host modal:
#   curl -fsSL <hub>/install-agent.sh | bash -s -- \
#     --hub <hub-url> --token <host_id>.<secret>
#
# What it does:
#   1. Parses --hub and --token args.
#   2. Detects local GPU vendor (nvidia-smi, then rocm-smi).
#   3. Downloads docker-compose.agent.{nvidia,amd}.yaml.
#   4. Generates .env (HUB_URL, HOST_ID, AGENT_TOKEN from --token).
#   5. Runs `docker compose up -d` and prints the agent status.
#
# Idempotent: re-running on an existing install keeps the .env intact
# and only pulls the latest compose + restarts.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

if [ -t 1 ]; then
  R="\033[0m"; B="\033[1m"; G="\033[32m"; Y="\033[33m"; C="\033[36m"; RED="\033[31m"
else
  R=""; B=""; G=""; Y=""; C=""; RED=""
fi

HUB_HTTP=""
TOKEN_COMPOSITE=""
BRANCH="${GPUVIEWR_BRANCH:-main}"
RAW_URL="https://raw.githubusercontent.com/Erreur32/GpuViewR/${BRANCH}"

# ── Args ─────────────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --hub)        HUB_HTTP="$2"; shift 2 ;;
    --token)      TOKEN_COMPOSITE="$2"; shift 2 ;;
    --branch)     BRANCH="$2"; RAW_URL="https://raw.githubusercontent.com/Erreur32/GpuViewR/${BRANCH}"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --hub <url> --token <host_id>.<secret>"
      echo "  --hub URL       e.g. http://hub.example.com:7510"
      echo "  --token TOKEN   composite token shown by the hub UI"
      echo "                  (format: <uuid>.<opaque-secret>)"
      echo "  --branch NAME   override GitHub branch (default: main)"
      exit 0 ;;
    *) echo -e "${RED}Unknown arg:${R} $1"; exit 1 ;;
  esac
done

if [ -z "$HUB_HTTP" ] || [ -z "$TOKEN_COMPOSITE" ]; then
  echo -e "${RED}Error:${R} --hub and --token are required."
  echo "Usage: $0 --hub <url> --token <host_id>.<secret>"
  exit 1
fi

echo ""
echo -e "${C}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
echo -e "${C}${B}  GpuViewR — remote agent install (Docker)${R}"
echo -e "${C}${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}"
echo ""

# ── Preflight ────────────────────────────────────────────────────────────────
need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo -e "${RED}Error:${R} required command '$1' not found in PATH."
    exit 1
  }
}
need curl
need docker
docker compose version >/dev/null 2>&1 || {
  echo -e "${RED}Error:${R} 'docker compose' v2 plugin is required."
  exit 1
}

# ── Split token: <HOST_ID>.<SECRET> on the FIRST dot ─────────────────────────
HOST_ID="${TOKEN_COMPOSITE%%.*}"
AGENT_TOKEN="${TOKEN_COMPOSITE#*.}"
if [ -z "$HOST_ID" ] || [ "$HOST_ID" = "$TOKEN_COMPOSITE" ] || [ -z "$AGENT_TOKEN" ]; then
  echo -e "${RED}Error:${R} --token must be in '<host_id>.<secret>' format."
  exit 1
fi

# ── Convert HUB_HTTP → HUB_WS ────────────────────────────────────────────────
# Hub UI URL (http://...:7510) → agent WS endpoint (ws://...:7510/agent)
case "$HUB_HTTP" in
  https://*)  HUB_WS="${HUB_HTTP/https:\/\//wss://}/agent" ;;
  http://*)   HUB_WS="${HUB_HTTP/http:\/\//ws://}/agent" ;;
  ws://*|wss://*)  HUB_WS="$HUB_HTTP" ;;
  *) echo -e "${RED}Error:${R} --hub must start with http:// https:// ws:// or wss://"; exit 1 ;;
esac
# Strip trailing /agent if user already wrote it once (re-add cleanly)
HUB_WS="${HUB_WS//\/agent\/agent/\/agent}"

# ── Vendor detection ─────────────────────────────────────────────────────────
VENDOR=""
if command -v nvidia-smi >/dev/null 2>&1; then
  VENDOR=nvidia
  echo -e "  ${G}✓${R} Detected NVIDIA GPU (nvidia-smi present)"
elif command -v rocm-smi >/dev/null 2>&1 || [ -x /opt/rocm/bin/rocm-smi ]; then
  VENDOR=amd
  echo -e "  ${G}✓${R} Detected AMD GPU (rocm-smi present)"
else
  echo -e "${RED}Error:${R} Neither nvidia-smi nor rocm-smi found on this host."
  echo -e "  ${Y}○${R} An agent without a GPU has nothing to report — install aborted."
  exit 1
fi

# ── Install dir ──────────────────────────────────────────────────────────────
# Same CWD-respecting logic as install.sh, with a different fallback name
# so the master install doesn't get clobbered if both ran in $HOME.
if [ -n "${GPUVIEWR_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="$GPUVIEWR_INSTALL_DIR"
elif [ "$PWD" = "/" ] || [ "$PWD" = "$HOME" ] || [ "$PWD" = "/tmp" ] || [ "$PWD" = "/root" ]; then
  # Build a stable, short suffix from the hub hostname so multiple agents
  # to different hubs land in distinct directories.
  HUB_SUFFIX=$(echo "$HUB_HTTP" | sed -E 's|^https?://||; s|:.*||; s|[^a-zA-Z0-9.-]|_|g' | head -c 40)
  INSTALL_DIR="$HOME/gpuviewr-agent-${HUB_SUFFIX:-default}"
else
  INSTALL_DIR="$PWD"
fi
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
echo -e "  ${G}✓${R} Install dir: ${C}${INSTALL_DIR}${R}"

# ── Refuse to clobber a master install in the same dir ───────────────────────
if [ -f docker-compose.yaml ] && grep -q "container_name: gpuviewr-hub" docker-compose.yaml 2>/dev/null; then
  echo -e "${RED}Error:${R} This directory already contains a master install (gpuviewr-hub service detected)."
  echo -e "  Pick a different directory:"
  echo -e "    ${C}mkdir ~/gpuviewr-agent-${HUB_SUFFIX:-target}${R}"
  echo -e "    ${C}cd ~/gpuviewr-agent-${HUB_SUFFIX:-target}${R}"
  echo -e "    ${C}<re-run the curl one-liner>${R}"
  exit 1
fi

# ── Pull compose ─────────────────────────────────────────────────────────────
echo -e "  ${B}→${R} Pulling docker-compose.agent.${VENDOR}.yaml from branch ${C}${BRANCH}${R}..."
curl -fsSL -o docker-compose.yaml \
  "${RAW_URL}/docker-compose.agent.${VENDOR}.yaml"

# ── .env (idempotent — keep existing) ────────────────────────────────────────
if [ ! -f .env ]; then
  TZ="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo 'Europe/Paris')"
  cat > .env <<EOF
# GpuViewR remote agent — generated by install-agent.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
HUB_URL=${HUB_WS}
HOST_ID=${HOST_ID}
AGENT_TOKEN=${AGENT_TOKEN}
TZ=${TZ}

# Tick rate (ms) — how often the agent samples the GPU.
TICK_MS=1000

# Override the GIDs if 'getent group video render' shows different numbers
# (AMD only — required to access /dev/kfd + /dev/dri).
# VIDEO_GID=44
# RENDER_GID=109

# Set to 1 only against a hub with a self-signed cert on private LAN.
# TLS_INSECURE=0
EOF
  chmod 600 .env
  echo -e "  ${G}✓${R} Generated ${C}.env${R} (mode 600)"
else
  echo -e "  ${Y}○${R} ${C}.env${R} already exists — leaving untouched."
fi

# ── Up ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${B}→${R} Pulling image..."
docker compose --progress quiet pull --quiet 2>/dev/null || true

echo -e "  ${B}→${R} Starting agent..."
docker compose --progress quiet up -d

# ── Final hint ───────────────────────────────────────────────────────────────
echo ""
echo -e "${G}${B}Done.${R}"
echo -e "  ${B}Vendor:${R}  ${C}${VENDOR}${R}"
echo -e "  ${B}Pushing to:${R} ${C}${HUB_WS}${R}"
echo -e "  ${B}Host ID:${R} ${C}${HOST_ID}${R}"
echo ""
echo -e "  Logs:    ${C}cd ${INSTALL_DIR} && docker compose logs -f${R}"
echo -e "  Update:  ${C}cd ${INSTALL_DIR} && docker compose pull && docker compose up -d${R}"
echo -e "  Stop:    ${C}cd ${INSTALL_DIR} && docker compose down${R}"
echo ""
echo -e "  Check the agent's status on the hub UI — Settings → Hosts."
echo ""
