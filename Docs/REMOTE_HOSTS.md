# Remote hosts (agents)

Every monitored machine runs a small agent that pushes its GPU samples to
the hub over a WebSocket. The local GPUs of the hub machine go through the
same path (a sidecar agent in the compose stack, see [Install](INSTALL.md)).
Agent internals and every environment variable are in
[`agent/README.md`](../agent/README.md).

- [Enroll a host](#enroll-a-host)
- [Linux (systemd)](#linux-systemd)
- [Linux (Docker)](#linux-docker)
- [Windows](#windows)
- [macOS (Apple Silicon)](#macos-apple-silicon)
- [One agent, several hubs](#one-agent-several-hubs)
- [Auto-update](#auto-update)

## Enroll a host

1. On the hub: **Settings → Hosts → + Add host**. Type a label, hit
   Generate. The modal shows the install command with the token
   (`<host_id>.<secret>`) **once**, with a tab per platform.
2. Run that command on the remote machine.

The hub serves the install scripts itself. `--url` accepts `http://`,
`https://`, `ws://` and `wss://`: the scripts convert as needed. If you only
have a bare token (e.g. after a rotation), prefix it with `<host_id>.` from
the hub UI.

## Linux (systemd)

The recommended install: no Docker needed on the remote machine.

```bash
curl -fsSL http://<your-hub>:7510/install.sh | sudo bash -s -- \
  --url http://<your-hub>:7510 \
  --token <host_id>.<secret>
```

Works on Debian / Ubuntu / RHEL / Rocky / Alma / Fedora, x86_64 and arm64.
Installs Node 22 if missing and sets up a systemd unit in
`/opt/gpuviewr-agent/`. NVIDIA needs the driver (`nvidia-smi`), AMD the
amdgpu driver (ROCm optional), Intel the i915 or xe driver.

**Intel GPUs (v0.11.0, not yet validated on real hardware)**: metrics and
the process list come from sysfs and DRM fdinfo, no vendor tool. GPU % is
measured on i915 only (xe reports engine cycles, not time), memory total is
unknown, and an integrated GPU shows the system memory mapped to it. For a
Docker agent, set `GPU_VENDOR=intel`, pass `/dev/dri` and keep
`cap_add: [SYS_PTRACE]` (start from `docker-compose.agent.amd.yaml`).

## Linux (Docker)

Copy `docker-compose.agent.nvidia.yaml` or `docker-compose.agent.amd.yaml`
from this repo to the remote machine, fill `HUB_URL` / `HOST_ID` /
`AGENT_TOKEN` in a `.env`, then `docker compose up -d`. Details in
[`agent/README.md`](../agent/README.md#docker-compose).

## Windows

Windows 10 1709+ / 11, Node 22+. In an **elevated** PowerShell:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
$env:GPVR_HUB_URL = 'http://<your-hub>:7510'
$env:GPVR_TOKEN   = '<host_id>.<secret>'
iex (iwr "$env:GPVR_HUB_URL/install.ps1" -UseBasicParsing).Content
```

- NVIDIA cards are read through `nvidia-smi.exe` (ships with the driver).
- AMD and Intel GPUs fall back to the Windows performance counters (PDH),
  the same source as Task Manager: utilization and VRAM only, no
  temperature or power.
- The process list comes from the per-process PDH counters, filtered to
  processes holding 256+ MiB of VRAM or active on the GPU in the last 30
  seconds.
- The installer registers a SYSTEM Scheduled Task that survives reboots
  and supervises the agent. Logs: `C:\ProgramData\GpuViewR-Agent\agent.log`.

## macOS (Apple Silicon)

```bash
curl -fsSL http://<your-hub>:7510/install.mac.sh | bash -s -- \
  --url http://<your-hub>:7510 \
  --token <host_id>.<secret>
```

Requires Node 22+ (`brew install node@22`). The installer adds a sudoers
rule scoped to `/usr/bin/powermetrics` (the only way to read Apple Silicon
GPU counters) and a per-user LaunchAgent. Apple Silicon has no discrete
VRAM, so the UI labels the memory metric "Unified". Intel Macs are not
supported. No process list yet.

> **Mac users wanted.** The macOS agent has only been tested against
> synthetic data. A two-minute capture from a real Apple Silicon Mac helps
> a lot, see [Help the macOS agent](../agent/README.md#help-the-macos-agent).

## One agent, several hubs

For failover, or to share a GPU box between dashboards:

```env
HUB_URLS=wss://hub1.example.com/agent,wss://hub2.example.com/agent
HOST_IDS=<id-on-hub1>,<id-on-hub2>
AGENT_TOKENS=<token-on-hub1>,<token-on-hub2>
```

The agent keeps one connection and one buffer per hub, so a slow hub
doesn't hold back the others.

## Auto-update

Off by default: turning it on lets the hub replace the agent's code on the
remote machine, so it is an explicit admin choice. Toggle it per host in
**Settings → Hosts** (circular arrows icon). The **Update now** button on
the same row pushes immediately.

The hub pushes the new `agent.mjs` over the existing WebSocket when an
agent reconnects with an older version, and on a periodic check (hourly by
default, `AUTO_UPDATE_CHECK_INTERVAL_MS`). The bundle is checked against
its SHA256 and swapped atomically, then the agent restarts:

| Install | How the new version starts |
|---|---|
| Linux systemd | Written to `/opt/gpuviewr-agent/agent.mjs`, `Restart=always` brings it back |
| Windows | Written as `agent.mjs.pending`, the launcher swaps it in (about 5 s downtime) |
| macOS | Swapped in place, `launchctl kickstart -k` restarts the LaunchAgent |
| Docker | Not supported: the bundle lives in the read-only image. Use `docker compose pull && docker compose up -d` |

A cooldown (`AUTO_UPDATE_COOLDOWN_MS`, 5 minutes) prevents update loops.
The toggle's tooltip shows the last check and last push per host.

Auto-update replaces `agent.mjs` only, never the agent's config file. To
change an agent's settings, re-run its installer.
