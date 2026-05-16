#!/usr/bin/env bash
# GpuViewR Agent installer — bare-metal Linux + systemd
#
# Hub URL is substituted at the time the hub serves this script,
# so the version you fetched with curl already knows where to call
# home. Re-running the installer is safe: it re-downloads the
# bundle and re-renders the systemd unit + env file.
#
# Usage (the hub UI prints the exact command with credentials):
#   curl -fsSL __HUB_URL__/install.sh | sudo bash -s -- \
#     --url __HUB_URL__ \
#     --token <host_id>.<secret>
#
# Flags:
#   --url URL          hub URL (http(s):// — script flips to ws(s):// for the agent)
#   --token TOKEN      one-shot enrollment token of the form `host_id.secret`
#   --interval MS      collector tick in ms (default 1000)
#   --features LIST    CSV of gpu,system,temps,processes (default all)
#   --uninstall        stop the service, remove the systemd unit + env + binary
#
# Distro support: Debian 11+ / Ubuntu 22+ / Rocky/Alma/RHEL 9+ / Fedora 38+.
# Anything else exits 1 with a hint — install Node 22 manually then re-run.

set -euo pipefail

HUB_URL=""
TOKEN=""
INTERVAL_MS=1000
FEATURES="gpu,system,temps,processes"
UNINSTALL=0

SERVICE_USER="gpuviewr-agent"
INSTALL_DIR="/opt/gpuviewr-agent"
BIN_PATH="${INSTALL_DIR}/agent.mjs"
ENV_FILE="/etc/gpuviewr-agent.env"
SVC_FILE="/etc/systemd/system/gpuviewr-agent.service"

# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
say() { printf '  %s\n' "$*"; }

# ──────────────────────────────────────────────────────────────────────
# Args
# ──────────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)        HUB_URL="$2"; shift 2 ;;
    --token)      TOKEN="$2"; shift 2 ;;
    --interval)   INTERVAL_MS="$2"; shift 2 ;;
    --features)   FEATURES="$2"; shift 2 ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    sed -n '2,22p' "$0" | sed 's/^# //; s/^#//'; exit 0 ;;
    *)            die "Unknown flag: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Must run as root (use sudo)."
[[ "$(uname -s)" == "Linux" ]] || die "Linux only. (See agent/README.md for Docker on macOS/WSL.)"

# ──────────────────────────────────────────────────────────────────────
# Uninstall path
# ──────────────────────────────────────────────────────────────────────
if [[ $UNINSTALL -eq 1 ]]; then
  say "Uninstalling gpuviewr-agent..."
  systemctl disable --now gpuviewr-agent 2>/dev/null || true
  rm -f "$SVC_FILE" "$ENV_FILE"
  rm -rf "$INSTALL_DIR"
  id -u "$SERVICE_USER" >/dev/null 2>&1 && userdel "$SERVICE_USER" 2>/dev/null || true
  systemctl daemon-reload
  ok "Removed."
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────
# Validate required flags
# ──────────────────────────────────────────────────────────────────────
[[ -n "$HUB_URL" ]] || die "Missing --url (use the one printed by the hub UI)."
[[ -n "$TOKEN"   ]] || die "Missing --token (printed once by the hub on enrollment)."

# Token format: <host_id>.<secret>. The hub UI concatenates these so the
# install line stays single-flag à la Beszel.
HOST_ID="${TOKEN%%.*}"
SECRET="${TOKEN#*.}"
HOST_ID="${HOST_ID#gpvr_}"  # tolerate a "gpvr_" prefix if the user pasted whole
[[ -n "$HOST_ID" && -n "$SECRET" && "$HOST_ID" != "$SECRET" ]] \
  || die "Invalid --token (expected <host_id>.<secret>; got: $TOKEN)"

# ──────────────────────────────────────────────────────────────────────
# Arch + distro probe
# ──────────────────────────────────────────────────────────────────────
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)   ARCH=x64 ;;
  aarch64|arm64)  ARCH=arm64 ;;
  *)              die "Unsupported architecture: $ARCH (need x86_64 or aarch64)." ;;
esac

. /etc/os-release 2>/dev/null || die "/etc/os-release missing; can't detect distro."
case "${ID:-}" in
  debian|ubuntu)              PKG_FAMILY=apt ;;
  rhel|rocky|almalinux|fedora) PKG_FAMILY=dnf ;;
  *)                           PKG_FAMILY="" ;;
esac

# ──────────────────────────────────────────────────────────────────────
# Pre-flight: vendor smi binary (nvidia-smi or rocm-smi)
# ──────────────────────────────────────────────────────────────────────
VENDOR_BIN=""
if command -v nvidia-smi >/dev/null 2>&1; then
  VENDOR_BIN="nvidia-smi"
  say "$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1) detected."
elif command -v rocm-smi >/dev/null 2>&1 || [[ -x /opt/rocm/bin/rocm-smi ]]; then
  VENDOR_BIN="rocm-smi"
  ROCM_BIN="$(command -v rocm-smi || echo /opt/rocm/bin/rocm-smi)"
  AMD_GPU="$("$ROCM_BIN" --showid --json 2>/dev/null | head -1 || true)"
  say "AMD GPU detected via ${ROCM_BIN}."
else
  die "Neither nvidia-smi nor rocm-smi found in PATH. Install vendor drivers (NVIDIA driver, or ROCm under /opt/rocm) then re-run."
fi

# ──────────────────────────────────────────────────────────────────────
# Node 22+ (install via NodeSource if missing or too old)
# ──────────────────────────────────────────────────────────────────────
need_node=0
if ! command -v node >/dev/null 2>&1; then
  need_node=1
else
  NODE_MAJOR="$(node -v | sed 's/^v//; s/\..*//')"
  [[ "${NODE_MAJOR:-0}" -lt 22 ]] && need_node=1
fi

if [[ $need_node -eq 1 ]]; then
  say "Node 22+ not detected; setting up NodeSource repository..."
  # NodeSource keyring + repo config done manually instead of `curl | bash`
  # so the script never runs unaudited remote shell code (Scorecard
  # Pinned-Dependencies). Mirrors what setup_22.x would do but with a
  # readable, reviewable code path.
  case "$PKG_FAMILY" in
    apt)
      install -d -m 0755 /etc/apt/keyrings
      curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
      chmod 0644 /etc/apt/keyrings/nodesource.gpg
      echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
      apt-get update
      apt-get install -y nodejs
      ;;
    dnf)
      rpm --import https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key
      cat > /etc/yum.repos.d/nodesource-nodejs.repo <<'EOF'
[nodesource-nodejs]
name=Node.js Packages for Linux RPM based distros - $basearch
baseurl=https://rpm.nodesource.com/pub_22.x/nodistro/nodejs/$basearch
priority=9
enabled=1
gpgcheck=1
gpgkey=https://rpm.nodesource.com/gpgkey/nodesource-repo.gpg.key
module_hotfixes=1
EOF
      dnf install -y nodejs
      ;;
    *)
      die "Unsupported distro ($ID). Install Node 22+ manually, then re-run."
      ;;
  esac
  ok "Node $(node -v) installed."
fi

# ──────────────────────────────────────────────────────────────────────
# User + install dir
# ──────────────────────────────────────────────────────────────────────
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir "$INSTALL_DIR" --no-create-home "$SERVICE_USER"
fi
install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR"

# ──────────────────────────────────────────────────────────────────────
# Download bundle from the hub (the hub serves /agent.mjs)
# ──────────────────────────────────────────────────────────────────────
say "Downloading agent bundle from ${HUB_URL%/}/agent.mjs..."
curl -fsSL --retry 3 -o "$BIN_PATH" "${HUB_URL%/}/agent.mjs"
chmod 0644 "$BIN_PATH"
chown "$SERVICE_USER:$SERVICE_USER" "$BIN_PATH"

# ──────────────────────────────────────────────────────────────────────
# Env file (chmod 600, root-owned, agent reads via systemd EnvironmentFile)
# ──────────────────────────────────────────────────────────────────────
# http(s):// from the user → ws(s):// for the agent. The hub's /agent
# WS endpoint is on the same origin as the HTTP API.
WS_URL="${HUB_URL/#http:/ws:}"
WS_URL="${WS_URL/#https:/wss:}"
umask 077
cat > "$ENV_FILE" <<EOF
HUB_URL=${WS_URL%/}/agent
HOST_ID=${HOST_ID}
AGENT_TOKEN=${SECRET}
TICK_MS=${INTERVAL_MS}
FEATURES=${FEATURES}
LOG_LEVEL=info
EOF
chmod 0600 "$ENV_FILE"
chown root:root "$ENV_FILE"

# ──────────────────────────────────────────────────────────────────────
# systemd unit
# ──────────────────────────────────────────────────────────────────────
NODE_BIN="$(command -v node)"
cat > "$SVC_FILE" <<EOF
[Unit]
Description=GpuViewR Agent
Documentation=https://github.com/Erreur32/GpuViewR
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${BIN_PATH}
Restart=on-failure
RestartSec=5

# Hardening — agent only needs network out + read /proc + spawn nvidia-smi.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=
# /proc is needed for the (eventual) processes feature; keep it readable.
ProcSubset=all

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now gpuviewr-agent

ok "Installed and started."
say "Hub URL  : ${WS_URL%/}/agent"
say "Host ID  : ${HOST_ID}"
say "Bundle   : ${BIN_PATH}"
say "Service  : gpuviewr-agent.service"
say ""
say "Watch the agent connect:"
say "  journalctl -u gpuviewr-agent -f"
say ""
say "To uninstall later:"
say "  curl -fsSL ${HUB_URL%/}/install.sh | sudo bash -s -- --uninstall"
