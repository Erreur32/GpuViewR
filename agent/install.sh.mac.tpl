#!/usr/bin/env bash
# GpuViewR Agent installer — macOS (Apple Silicon, powermetrics)
#
# Hub URL is substituted at the time the hub serves this script, so the
# version you fetched with curl already knows where to call home.
# Re-running the installer is safe: it re-downloads the bundle and
# re-renders the LaunchAgent + sudoers + env file.
#
# Usage (the hub UI prints the exact command with credentials):
#   curl -fsSL __HUB_URL__/install.mac.sh | bash -s -- \
#     --url __HUB_URL__ \
#     --token <host_id>.<secret>
#
# Flags:
#   --url URL          hub URL (http(s):// — script flips to ws(s):// for the agent)
#   --token TOKEN      one-shot enrollment token of the form `host_id.secret`
#   --interval MS      collector tick in ms (default 1000)
#   --features LIST    CSV of gpu,system,temps,processes (default gpu,system,temps — no processes, see below)
#   --uninstall        stop the LaunchAgent, remove the plist + sudoers + install dir
#
# Requirements: macOS 13+ on Apple Silicon (arm64), Node.js 22+.
# Intel Macs work too (powermetrics is universal) but the unified-memory
# mapping in the collector assumes Apple Silicon — expect a rough edge.
#
# Privileges: the agent itself runs as YOUR user via a per-user
# LaunchAgent, never as root. Only `powermetrics` (an Apple-signed
# system binary) runs elevated, via a narrowly-scoped `sudo -n` rule
# installed to /etc/sudoers.d/gpuviewr-agent. See Docs/MACOS_AGENT.md §3
# for the reasoning against a root LaunchDaemon.
#
# Note: on first launch you may see a one-time macOS prompt asking to
# allow `powermetrics`/`node` to monitor system activity or accept
# incoming network connections — that's expected, click Allow.
#
# Processes are not collected on macOS (no /proc, no per-PID GPU API
# without private Apple frameworks) — GPU samples stream normally.

set -euo pipefail

HUB_URL=""
TOKEN=""
INTERVAL_MS=1000
FEATURES="gpu,system,temps"
UNINSTALL=0

INSTALL_DIR="${HOME}/Library/Application Support/GpuViewR-Agent"
PLIST_LABEL="com.gpuviewr.agent"
PLIST_PATH="${HOME}/Library/LaunchAgents/${PLIST_LABEL}.plist"
BIN_PATH="${INSTALL_DIR}/agent.mjs"
ENV_PATH="${INSTALL_DIR}/agent.env"
LOG_PATH="${INSTALL_DIR}/agent.log"
SUDOERS_PATH="/etc/sudoers.d/gpuviewr-agent"
POWERMETRICS_BIN="/usr/bin/powermetrics"

# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
say() { printf '  %s\n' "$*"; }

uid_gui_target() { printf 'gui/%s/%s' "$(id -u)" "$PLIST_LABEL"; }

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
    -h|--help)    sed -n '2,29p' "$0" | sed 's/^# //; s/^#//'; exit 0 ;;
    *)            die "Unknown flag: $1" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only. Use install.sh for Linux or install.ps1 for Windows."
ARCH="$(uname -m)"
[[ "$ARCH" == "arm64" ]] || say "WARNING: Intel Mac detected (${ARCH}). powermetrics works, but the unified-memory mapping in the collector assumes Apple Silicon."

# ──────────────────────────────────────────────────────────────────────
# Uninstall path
# ──────────────────────────────────────────────────────────────────────
if [[ $UNINSTALL -eq 1 ]]; then
  say "Uninstalling gpuviewr-agent..."
  launchctl bootout "$(uid_gui_target)" 2>/dev/null || true
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  rm -rf "$INSTALL_DIR"
  if [[ -f "$SUDOERS_PATH" ]]; then
    sudo rm -f "$SUDOERS_PATH" || say "Could not remove ${SUDOERS_PATH} (need sudo) — remove it manually."
  fi
  ok "Removed."
  exit 0
fi

# ──────────────────────────────────────────────────────────────────────
# Validate required flags
# ──────────────────────────────────────────────────────────────────────
[[ -n "$HUB_URL" ]] || die "Missing --url (use the one printed by the hub UI)."
[[ -n "$TOKEN"   ]] || die "Missing --token (printed once by the hub on enrollment)."

# Token format: <host_id>.<secret>. Same parsing + edge cases as
# install.sh.tpl / install.ps1.tpl (cf. reference_install_quirks).
[[ "$TOKEN" == *.* ]] \
  || die "Invalid --token: missing '.'. Expected format <host_id>.<secret> from the hub's 'Add Host' modal. Got: $TOKEN"
HOST_ID="${TOKEN%%.*}"
SECRET="${TOKEN#*.}"
HOST_ID="${HOST_ID#gpvr_}"  # tolerate a "gpvr_" prefix if the user pasted whole
[[ -n "$HOST_ID" && -n "$SECRET" && "$HOST_ID" != "$SECRET" ]] \
  || die "Invalid --token (expected <host_id>.<secret>; got: $TOKEN)"

# ──────────────────────────────────────────────────────────────────────
# Pre-flight: Node 22+
# ──────────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  die "Node.js 22+ not found. Install it with 'brew install node@22' (https://brew.sh) or the .pkg from https://nodejs.org/en/download, then re-run this script."
fi
NODE_MAJOR="$(node -v | sed 's/^v//; s/\..*//')"
[[ "${NODE_MAJOR:-0}" -lt 22 ]] && die "Node.js $(node -v) is too old (need 22+). 'brew upgrade node@22' or grab the latest LTS from https://nodejs.org/en/download, then re-run."
NODE_BIN="$(command -v node)"
ok "Node $(node -v) at ${NODE_BIN}"

# ──────────────────────────────────────────────────────────────────────
# Pre-flight: powermetrics (ships with macOS, but check anyway)
# ──────────────────────────────────────────────────────────────────────
[[ -x "$POWERMETRICS_BIN" ]] || die "${POWERMETRICS_BIN} not found. This should ship with every macOS install — is this a stripped-down/CI image?"

# ──────────────────────────────────────────────────────────────────────
# Install dir + bundle download
# ──────────────────────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"

HTTP_URL="${HUB_URL/#ws:/http:}"
HTTP_URL="${HTTP_URL/#wss:/https:}"
WS_URL="${HUB_URL/#http:/ws:}"
WS_URL="${WS_URL/#https:/wss:}"

say "Downloading agent bundle from ${HTTP_URL%/}/agent.mjs..."
curl -fsSL --retry 3 -o "$BIN_PATH" "${HTTP_URL%/}/agent.mjs"
chmod 0644 "$BIN_PATH"

# ──────────────────────────────────────────────────────────────────────
# sudoers — narrowly scoped NOPASSWD rule for powermetrics only. The
# agent process itself stays unprivileged (runs as $USER via LaunchAgent
# below); only the `sudo -n powermetrics ...` child spawn needs root, to
# read SMC sensors + GPU energy counters. visudo -c validates syntax
# before it's ever installed — a broken /etc/sudoers.d file can lock
# sudo entirely, so we refuse to leave one in place if validation fails.
# ──────────────────────────────────────────────────────────────────────
SUDOERS_TMP="$(mktemp)"
cat > "$SUDOERS_TMP" <<EOF
# Managed by GpuViewR install.mac.sh — do not edit by hand.
# Lets the current user run powermetrics (Apple-signed system binary)
# without a password, and nothing else.
${USER} ALL=(root) NOPASSWD: ${POWERMETRICS_BIN}
EOF
if ! visudo -c -f "$SUDOERS_TMP" >/dev/null 2>&1; then
  rm -f "$SUDOERS_TMP"
  die "Generated sudoers rule failed 'visudo -c' validation — aborting before touching /etc/sudoers.d."
fi
say "Installing ${SUDOERS_PATH} (requires sudo password once)..."
sudo install -o root -g wheel -m 0440 "$SUDOERS_TMP" "$SUDOERS_PATH"
rm -f "$SUDOERS_TMP"
# Confirm the rule actually works non-interactively before we hand the
# agent a config that would otherwise crash-loop on 'sudo: a password is required'.
if ! sudo -n "$POWERMETRICS_BIN" -h >/dev/null 2>&1; then
  say "WARNING: 'sudo -n ${POWERMETRICS_BIN} -h' still failed after installing the sudoers rule."
  say "         The agent will retry at boot and log the exact error — check 'sudo visudo -c' and"
  say "         ${SUDOERS_PATH} by hand if it keeps failing."
else
  ok "sudo -n powermetrics: OK"
fi

# ──────────────────────────────────────────────────────────────────────
# Env file (chmod 600, sourced via the plist's EnvironmentVariables —
# written here mainly as a human-readable record of what was installed)
# ──────────────────────────────────────────────────────────────────────
umask 077
cat > "$ENV_PATH" <<EOF
HUB_URL=${WS_URL%/}/agent
HOST_ID=${HOST_ID}
AGENT_TOKEN=${SECRET}
TICK_MS=${INTERVAL_MS}
FEATURES=${FEATURES}
GPU_VENDOR=apple
LOG_LEVEL=info
EOF
chmod 0600 "$ENV_PATH"

# ──────────────────────────────────────────────────────────────────────
# LaunchAgent plist — runs as the current user (NOT root). KeepAlive
# relaunches node within ~1s of a clean exit(0), which is how the
# agent applies hub-pushed updates (cf. transport.ts applyAgentUpdate,
# same atomic-rename path as Linux — APFS supports rename(2) the same
# as ext4).
# ──────────────────────────────────────────────────────────────────────
mkdir -p "$(dirname "$PLIST_PATH")"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${BIN_PATH}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HUB_URL</key><string>${WS_URL%/}/agent</string>
    <key>HOST_ID</key><string>${HOST_ID}</string>
    <key>AGENT_TOKEN</key><string>${SECRET}</string>
    <key>TICK_MS</key><string>${INTERVAL_MS}</string>
    <key>FEATURES</key><string>${FEATURES}</string>
    <key>GPU_VENDOR</key><string>apple</string>
  </dict>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
EOF

# ──────────────────────────────────────────────────────────────────────
# (Re)load — bootout + unload the old instance first so a rotated token
# actually takes effect (an already-running LaunchAgent keeps its old
# env otherwise), same lifecycle pattern as install.ps1.tpl's
# Stop-ScheduledTask-then-kill-leaked-children dance.
# ──────────────────────────────────────────────────────────────────────
launchctl bootout "$(uid_gui_target)" 2>/dev/null || true
launchctl unload "$PLIST_PATH" 2>/dev/null || true
sleep 0.5
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || launchctl load -w "$PLIST_PATH"
launchctl kickstart -k "$(uid_gui_target)" 2>/dev/null || true

ok "Installed and started."
say "Hub URL  : ${WS_URL%/}/agent"
say "Host ID  : ${HOST_ID}"
say "Bundle   : ${BIN_PATH}"
say "LaunchAgent : ${PLIST_LABEL}"
say ""
say "Watch the agent connect:"
say "  tail -f '${LOG_PATH}'"
say ""
say "You may see a one-time system prompt about powermetrics/node monitoring"
say "system activity or accepting incoming connections — click Allow."
say ""
say "To uninstall later:"
say "  curl -fsSL ${HUB_URL%/}/install.mac.sh | bash -s -- --uninstall"
