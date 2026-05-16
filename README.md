# GpuViewR: NVIDIA GPU Dashboard

<div align="center">

<img src="public/GpuViewR-Ban.png" alt="GpuViewR"  width="628" height="458" />

[![Release](https://img.shields.io/github/v/release/Erreur32/GpuViewR?style=for-the-badge&logo=github&logoColor=white&label=Release&color=111827)](https://github.com/Erreur32/GpuViewR/releases)
![Docker](https://img.shields.io/badge/Docker-Ready-1f2937?style=for-the-badge&logo=docker&logoColor=38bdf8)
![NVIDIA](https://img.shields.io/badge/NVIDIA-GPU-111827?style=for-the-badge&logo=nvidia&logoColor=76b900)
[![License](https://img.shields.io/badge/License-MIT-111827?style=for-the-badge&color=111827&labelColor=111827&logoColor=white)](LICENSE)

[![OSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Erreur32/GpuViewR?style=for-the-badge&label=Scorecard)](https://scorecard.dev/viewer/?uri=github.com/Erreur32/GpuViewR)
[![CodeQL](https://img.shields.io/badge/CodeQL-active-brightgreen?style=for-the-badge&logo=github)](https://github.com/Erreur32/GpuViewR/security/code-scanning)
[![Snyk](https://img.shields.io/github/actions/workflow/status/Erreur32/GpuViewR/snyk.yml?style=for-the-badge&logo=snyk&logoColor=white&label=Snyk&color=111827)](https://github.com/Erreur32/GpuViewR/actions/workflows/snyk.yml)

[![SonarCloud](https://img.shields.io/sonar/quality_gate/Erreur32_GpuViewR2?server=https%3A%2F%2Fsonarcloud.io&style=for-the-badge&logo=sonarcloud&logoColor=white&label=Sonar)](https://sonarcloud.io/summary/overall?id=Erreur32_GpuViewR2)
[![Security](https://sonarcloud.io/api/project_badges/measure?project=Erreur32_GpuViewR2&metric=security_rating)](https://sonarcloud.io/summary/overall?id=Erreur32_GpuViewR2)
[![Maintainability](https://sonarcloud.io/api/project_badges/measure?project=Erreur32_GpuViewR2&metric=sqale_rating)](https://sonarcloud.io/summary/overall?id=Erreur32_GpuViewR2)
 
**Real-time NVIDIA GPU monitoring dashboard, packaged as a single Docker image.**

[**🔴 Live demo**](https://erreur32.github.io/GpuViewR/) · [**🛰️ Multi-host demo**](https://erreur32.github.io/GpuViewR/fleet?fleet=1) (4 fake hosts) — synthetic data, runs entirely in the browser

[Screenshot](#screenshot) · [Quick start](#quick-start) · [Configuration](#configuration) · [First login](#first-login) · [Customizing](#customizing-the-look) · [Alerts](#alerts) · [Multi-host](#multi-host) · [Roadmap](#roadmap)

</div>

---

## Screenshot

<div align="center">

<img src="public/CpuViewR_screnshot.png" alt="GpuViewR dashboard screenshot" />

</div>

---

## Features

- 🌍 **i18n**: English / French out of the box
- 🔢 **Multi-GPU**: automatic tabs when 2+ devices are detected
- 🛰️ **Multi-host (v0.3.0)**: one hub aggregates `nvidia-smi` from N remote machines via a lightweight WebSocket agent — see [Multi-host](#multi-host)
- 🐳 **Single Docker image**: multi-arch (amd64 / arm64), Node 22 Debian slim

---

## Quick start

### Prerequisites

- An **NVIDIA** host with the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html),
  **OR** an **AMD/ROCm** host (jump to [AMD / ROCm support](#amd--rocm-support)
  for the AMD-specific compose recipe).
- Docker Engine 23+ with the Compose plugin.

The hub also runs vendor-neutral when no local GPU is present — it just
serves the UI and waits for remote agents to enroll via Settings →
Hosts.

### Step 1: create your `.env`

```bash
mkdir -p ~/gpuviewr && cd ~/gpuviewr

# Generate a JWT secret (required)
echo "JWT_SECRET=$(openssl rand -base64 32)"  > .env

# Pin the LAN IP that the boot banner should print (recommended in Docker)
echo "HOST_IP=$(hostname -I | awk '{print $1}')" >> .env

# Optional overrides
# echo "DASHBOARD_PORT=7510"   >> .env  # change host port if 7510 is taken
# echo "TZ=Europe/Paris"       >> .env
```

### Step 2: grab `docker-compose.yaml`

Since v0.5.0 there is a **single** compose file. The vendor is picked
via the `COMPOSE_PROFILES` env (line in `.env`) so the same file
works on NVIDIA, AMD, or aggregator-only hosts:

```bash
curl -fsSL -o docker-compose.yaml \
  https://raw.githubusercontent.com/Erreur32/GpuViewR/main/docker-compose.yaml
```

Then in your `.env`:

```env
COMPOSE_PROFILES=nvidia      # or: amd, or empty (= aggregator-only)
```

The `docker-compose.yaml` defines three services — `hub` (always started),
`agent-nvidia` (started when `COMPOSE_PROFILES=nvidia`), and
`agent-amd` (when `COMPOSE_PROFILES=amd`). Only one of the two
sidecar services exists at runtime; they share the same container
name so you can switch vendors by editing `.env` and re-running
`docker compose up -d`.

> **Easier**: skip Step 1 + Step 2 entirely and let `install.sh`
> auto-detect everything:
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/Erreur32/GpuViewR/main/install.sh | bash
> ```

Browse the file directly on GitHub to see exactly what gets pulled —
it's short and heavily commented:

- [`docker-compose.yaml`](docker-compose.yaml) (hub + nvidia/amd sidecars via profiles)
- [`docker-compose.agent.nvidia.yaml`](docker-compose.agent.nvidia.yaml) (remote NVIDIA agent — different host than the hub)
- [`docker-compose.agent.amd.yaml`](docker-compose.agent.amd.yaml) (remote AMD agent)

> **Process names — alternative.** If you prefer the simpler model, drop
> the `/proc:/host/proc:ro` mount + `HOST_PROC` env and add `pid: host`
> to the service. Trade-off: the container then sees every process on the
> host (less isolation, simpler config).

### Step 3: start it

```bash
docker compose up -d
docker compose logs -f gpuviewr   # watch the boot banner
```

The boot banner prints the URL to open. With defaults that's
**`http://<your-host-ip>:7510`**.

> **Port mapping.** Inside the container the app listens on **`3015`**.
> Docker maps the **host port `7510`** to the container's `3015`. You always
> open the dashboard on the **host port** (`7510` by default, or whatever
> you set in `DASHBOARD_PORT`). The `3015` you see in the banner is a
> reminder of the internal port, not the URL to use from your browser.

---

## First login

GpuViewR ships **without** any pre-baked credentials.

1. Open the dashboard URL. The login page detects an empty database and
   switches to **"Create admin account"**.
2. Pick your own `username` (≥ 3 chars) and `password` (≥ 8 chars).
3. The first user is granted role `admin` automatically. Subsequent
   registrations create regular `user` accounts.

**Lost your password?** Wipe the user store and start over:

```bash
docker compose down
rm -rf ./data/gpuviewr.db*
docker compose up -d
```

(GPU history is stored in the same SQLite file, so it will be reset too.)

---

## Configuration

All settings are read from `.env`.

| Variable | Default | Purpose |
|---|---:|---|
| `JWT_SECRET` | _none_ | **Required.** Secret for signing JWTs. `openssl rand -base64 32` |
| `DASHBOARD_PORT` | `7510` | Host port mapped to the container. Open this in your browser. |
| `HOST_IP` | _auto_ | LAN IP shown in the boot banner. Auto-detected if unset; recommended in Docker. |
| `PUBLIC_URL` | _none_ | Set when you serve GpuViewR behind a reverse proxy. |
| `TZ` | `Europe/Paris` | Container timezone. |
| `GPU_TICK_MS` | `1000` | How often the active vendor smi (nvidia-smi / rocm-smi) is sampled. |
| `GPU_VENDOR` | `auto` | `auto` probes nvidia-smi then rocm-smi at boot; `nvidia` / `amd` pin the collector. |
| `ROCM_SMI_PATH` | `/opt/rocm/bin/rocm-smi` | Where to find rocm-smi inside the container. Override when your ROCm install lives elsewhere. |
| `HUB_HOSTNAME` | _auto_ | Hostname shown on the Hosts table / Dashboard / System page for the hub itself. Auto-resolved from `/host/etc/hostname` when the compose bind-mounts it; set explicitly to override (e.g. `HUB_HOSTNAME=jarvis`). |
| `RETENTION_DAYS` | `7` | How long historical metrics are kept in SQLite. |

Internal ports (rarely need to change):

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3015` | Container-internal HTTP/WebSocket port. Must match the right side of the compose port mapping. |

### Updating

The dashboard polls GitHub once per `frequencyHours` (default 24 h) and
shows a banner when a newer GHCR image is available. Apply it from the host
with:

```bash
docker compose pull && docker compose up -d
```

---

## Customizing the look

### Themes

Five themes ship by default: `Midnight`, `Graphite`, `Oceanic` (dark),
`Daylight`, `Paper` (light). Pick one in **Settings → Theme**.

### Gauges

Toggle between **arc rings** and **Grafana-style horizontal bars** from the
dashboard toolbar or **Settings → Gauge style**.

### Languages

English and French are shipped. Use **Settings → Language** to switch.

---

## Alerts

Define rules in **Alerts → New rule** (admin only). Each rule has:

| Field | Effect |
|---|---|
| Metric | `temperature`, `utilization`, `memory %`, `power`, `fan_speed` |
| Condition | `above` (≥) or `below` (≤) the threshold |
| Threshold | Numeric value |
| Sustained (s) | The threshold must hold for this long before firing |
| Cooldown (s) | Minimum gap between two firings of the same rule |
| GPU index | Empty = applies to all GPUs |
| Notify browser | Native `Notification` API |
| Notify sound | Plays a short tone |

When a rule fires, GpuViewR pushes an `alert` frame on the same WebSocket -
the UI shows a toast immediately and (optionally) raises a browser
notification. When the metric returns into range, a `resolved` event is
emitted and a green toast confirms it.

Rules can also be **scoped to a single host** (multi-host installs only —
leave empty for "fires on every host"), and the resulting event carries
its `host_id` so Discord / Telegram digests prefix lines with the host
they came from.

---

## Multi-host

Since **v0.3.0** a single GpuViewR install can monitor GPUs across many
machines. Architecture: one **hub** (this Docker container) plus N
lightweight **agents** that push `nvidia-smi` samples to it over an
outbound WebSocket.

> **Terminology note:** the UI tab is called **Hosts** (the centralised
> overview of every machine the hub monitors). Other tools in this space
> — AWS Fleet, FleetDM, HashiCorp Nomad — call the same concept a
> "fleet". Both terms refer to the same thing here, and you'll still see
> `fleet` in URLs, store keys, and internal component names.

| Component | What it does | Lives where |
|---|---|---|
| **Hub** | UI, auth, DB, alerts engine, exports (Prom/MQTT/Influx/Webhook), `/agent` WS endpoint | Wherever you ran the Quick start above |
| **Agent** | Spawns local `nvidia-smi`, ships `GpuSample`s to the hub | One per remote machine you want to monitor |

The local `nvidia-smi` of the hub is treated as a first-class host
(reserved id `local`), so single-host installs keep working zero-touch.
You only need agents if you want to monitor _other_ machines.

### Adding a remote host

1. **On the hub**, sign in as admin. Go to **Settings → Hosts → + Add host**.
   Type a label (e.g. `rtx-rig`), click Generate.
2. The modal switches to a copy-once view with two install modes: a
   single-line `curl ... install.sh` (recommended) and a `docker run`
   alternative. Both contain the same one-shot token; the modal stresses
   that the token is **shown only once**.
3. **On the remote machine**, pick one:

   **Mode A — curl install (no Docker required)**

   ```bash
   curl -fsSL https://gpu.example.com/install.sh | sudo bash -s -- \
     --url https://gpu.example.com \
     --token <host_id>.<secret>
   ```

   The script (served by the hub itself, see [agentDistribution.ts](server/routes/agentDistribution.ts))
   installs Node 22 via NodeSource if missing, downloads `agent.mjs` from
   the hub, creates a `gpuviewr-agent` system user + a systemd unit, and
   starts the service. Watch logs with `journalctl -u gpuviewr-agent -f`.

   **Mode B — Docker**

   ```bash
   docker run -d --name gpuviewr-agent \
     --gpus all \
     --restart unless-stopped \
     -e HUB_URL=wss://gpu.example.com/agent \
     -e HOST_ID=<uuid-from-hub> \
     -e AGENT_TOKEN=<token-from-hub> \
     ghcr.io/erreur32/gpuviewr-agent:latest
   ```

   Pre-reqs: NVIDIA Container Toolkit on the remote, outbound TCP to the
   hub. Inside 1-3 s the new host appears `online` in the hub UI.

   > Hub maintainer: the curl path needs `agent/dist/agent.mjs` to exist
   > on the hub side. Run `npm run build:agent` once after a fresh clone
   > to build it; the Docker hub image bundles it automatically.

A drop-in [`docker-compose.agent.nvidia.yaml`](docker-compose.agent.nvidia.yaml) is
provided at the repo root for users who prefer compose, and a bare-metal
systemd path (Node SEA binary) is documented in
[`agent/README.md`](agent/README.md) for hosts without Docker.

### AMD / ROCm support

GpuViewR speaks `rocm-smi` end-to-end since v0.4.0 — both the hub and
the remote agent. RDNA3, Strix Halo APUs (Radeon 8060S), discrete
Radeon (RX 7900, etc.) are first-class. AMD and NVIDIA hosts can sit
side by side in the same fleet, and a single AMD box can run as a
standalone hub without any agent dance.

What works (parity with the NVIDIA agent):

- Temperature, utilization, power, graphics clock, VRAM used/total
- GPU process list (pid, name, VRAM used, full command, CPU %)
- Per-host card on the Hosts tab + history + alerts + exports

What's `null` on ROCm (driver doesn't expose it):

- Memory clock on APUs (system RAM = VRAM, no separate clock)
- Fan speed (most RDNA3 desktop cards report it via lm-sensors instead;
  picked up by the [system temperatures panel](#features) regardless)
- PCIe gen/width and RX/TX throughput
- Per-process GPU % (no `nvidia-smi pmon` equivalent in `rocm-smi`)

Two AMD install paths:

**(a) Single-host AMD — hub local, no agent** (since v0.4.0)

The hub container talks to `rocm-smi` directly on the host. Pick this
when you have one AMD box and want the simplest possible setup. No
`git clone` needed — pull the compose file from the tag and you're
done:

```bash
# 1. Pre-flight on the host — JSON should come out clean.
rocm-smi --showid --json
getent group video render          # note the GIDs (Debian: 44 / 109)

# 2. New folder, grab the compose, write the .env.
mkdir gpuviewr && cd gpuviewr
curl -fsSL -o docker-compose.yaml \
  https://raw.githubusercontent.com/Erreur32/GpuViewR/main/docker-compose.yaml
cat > .env <<EOF
JWT_SECRET=$(openssl rand -base64 32)
DASHBOARD_PORT=7510
TZ=Europe/Paris
# Override if getent showed different GIDs:
# VIDEO_GID=44
# RENDER_GID=109
EOF

# 3. Up.
docker compose -f docker-compose.yaml up -d
docker compose -f docker-compose.yaml logs -f
```

UI on `http://<your-box>:7510` — first user becomes admin.

**(b) Remote AMD agent — hub elsewhere, agent on the AMD box**

When the hub already runs on another machine (NVIDIA box, dev laptop,
etc.) and you want to enrol an AMD host into the existing fleet:

```bash
# 1. Pre-flight check — JSON should come out clean.
rocm-smi --showid --json

# 2. Pull the agent compose + a .env carrying HUB_URL / HOST_ID /
#    AGENT_TOKEN (printed once by Settings → Hosts → + Add host on
#    the hub).
mkdir gpuviewr-agent && cd gpuviewr-agent
curl -fsSL -o docker-compose.agent.amd.yaml \
  https://raw.githubusercontent.com/Erreur32/GpuViewR/main/docker-compose.agent.amd.yaml
# Edit .env with the values copied from the hub UI:
cat > .env <<EOF
HUB_URL=wss://gpu.example.com/agent
HOST_ID=<uuid-from-hub>
AGENT_TOKEN=<token-from-hub>
EOF

docker compose -f docker-compose.agent.amd.yaml up -d
```

Both compose files bind-mount the host's `/opt/rocm` tree (rocm-smi
is a Python script, so we mount the parent dir to get the interpreter
entry point AND its native libraries in one shot), `/etc/hostname`
read-only (so the UI shows the real machine name instead of the
container id), and use `/dev/kfd` + `/dev/dri` instead of the NVIDIA
Container Toolkit. The hub +
agent images both ship `python3` so the script can run inside the
container, and set `LD_LIBRARY_PATH=/opt/rocm/lib:/opt/rocm/lib64`
so the ctypes loader finds `librocm_smi64.so.1` — without it
rocm-smi prints an error to stderr but **exits 0 with empty stdout**,
and you silently get no samples. Check `getent group video render`
on your host — if `render` isn't GID 109 (ROCm installers sometimes
shift it to 992), set `VIDEO_GID` and `RENDER_GID` in `.env`
accordingly. If you see `Fail to open libdrm_amdgpu.so` on startup,
install `libdrm-amdgpu1` to silence it — the warning is cosmetic,
JSON output is valid either way.

Multi-GPU AMD boxes currently attribute all processes to `card0`
(single-card limitation, lifted in a follow-up). NVIDIA agents are
unaffected. Set `GPU_VENDOR=auto` (default) to let the agent probe
both binaries and pick whichever responds; `GPU_VENDOR=amd` or
`nvidia` pins it explicitly.

#### Troubleshooting: the UI shows a container id instead of my hostname

`/proc/sys/kernel/hostname` is a pseudo-virtual file whose value
follows the reading process's UTS namespace, so even with
`/proc:/host/proc:ro` mounted it can still return the container id
(e.g. `9490fde69ed2`) instead of the real hostname. The compose
files since v0.4.1 also bind-mount `/etc/hostname` as a static
fallback. If yours predates that or sits behind a hardened mount,
either:

```bash
# 1. (Recommended) Refresh your compose to the latest with the
#    /etc/hostname bind-mount baked in:
curl -fsSL -o docker-compose.yaml \
  https://raw.githubusercontent.com/Erreur32/GpuViewR/main/docker-compose.yaml
docker compose -f docker-compose.yaml down
docker compose -f docker-compose.yaml up -d

# 2. (Workaround) Pin the hostname explicitly via .env — wins over
#    any auto-detection, no compose change needed:
echo "HUB_HOSTNAME=jarvis" >> .env
docker compose up -d --force-recreate
```

### OS support

The agent runs on:

- **Linux glibc** (Debian 11+ / Ubuntu 22+ / RHEL 9+ / Rocky / Fedora 38+ / openSUSE) on `x86_64` and `arm64` (Jetson / Grace) — Docker or systemd.
- **Windows via WSL2** — the agent runs inside the WSL2 Linux distro, not native Windows.
- **Alpine bare-metal** hosts — Docker only (the agent container is glibc, the host OS doesn't matter).

Native Windows and macOS are **not** supported — see
[`Docs/MULTI_HOST_PLAN.md`](Docs/MULTI_HOST_PLAN.md) §15.0 for the
reasoning.

### Exports become host-aware

When at least one agent is enrolled, the Prometheus / InfluxDB / MQTT /
Webhook exports gain a `host` dimension so dashboards can filter and
group by machine. This **changes the wire format** even for users who
stay mono-host — see [`Docs/MIGRATION.md`](Docs/MIGRATION.md#v02x--v03x--multi-host-migration)
for the breaking-change recap and Grafana / Home Assistant /
Influx migration snippets.

### Architecture & decisions

Full design (transport, auth model, schema migration, agent buffering,
fleet UI plan, the nine decisions D1-D9 that drove the implementation)
lives in [`Docs/MULTI_HOST_PLAN.md`](Docs/MULTI_HOST_PLAN.md).

---

## Roadmap

### Available since v0.3.0

- **Multi-host fan-out** — hub + agents, host-tagged exports,
  host-scoped alerts. See [Multi-host](#multi-host) above.

### Planned (v0.3.x)

- **Remote system / process collection** — agents currently ship
  GPU samples only; CPU / load / memory / process names from the
  remote host are reserved for a follow-up release.

---

## Credits

GpuViewR is a complete rewrite **inspired by and originally based on**
[**bigsk1/gpu-monitor**](https://github.com/bigsk1/gpu-monitor) (MIT License).
The original project provided the foundation: GPU data collection approach via
`nvidia-smi`, the SQLite schema for historical metrics, and the Docker
packaging strategy.

<details>
<summary><b>What changed in GpuViewR</b> (click to expand)</summary>

<table>
<thead>
<tr>
  <th width="22%">Area</th>
  <th width="36%"><sub>🪦</sub> Original <code>gpu-monitor</code></th>
  <th width="42%"><sub>🚀</sub> GpuViewR</th>
</tr>
</thead>
<tbody>

<tr><td>📡 <b>Data transport</b></td>
<td>Polling JSON every <b>5 s</b>, chart every <b>30 s</b></td>
<td><b>WebSocket</b> streaming every <b>1 s</b>, auto-reconnect with backoff</td></tr>

<tr><td>⚙️ <b>Collector</b></td>
<td>Bash script (≈ 630 lines), <code>nvidia-smi</code> + intermediate JSON files</td>
<td>TypeScript service, <code>nvidia-smi</code> spawned from Node, batched DB writes</td></tr>

<tr><td>💾 <b>Storage</b></td>
<td>SQLite (single GPU column), 24 h retention</td>
<td>SQLite WAL + index per GPU, <b>7 d retention</b> (configurable)</td></tr>

<tr><td>🎨 <b>Frontend</b></td>
<td>One HTML file, <b>1 183 lines</b> of inline HTML+CSS+JS</td>
<td><b>React 19</b> + Vite + TailwindCSS, modular components, ~25 KB gzip</td></tr>

<tr><td>📊 <b>Charts</b></td>
<td>Chart.js 3.7 (≈ 195 KB)</td>
<td><b>uPlot</b> (≈ 40 KB), built for live time-series</td></tr>

<tr><td>🌈 <b>Theming</b></td>
<td>One fixed dark palette</td>
<td><b>5 themes</b> (3 dark + 2 light) via CSS variables</td></tr>

<tr><td>📐 <b>Gauges</b></td>
<td>Static horizontal bars</td>
<td><b>Arc rings or Grafana-style bars</b>, switchable; sparklines per card</td></tr>

<tr><td>🔢 <b>Multi-GPU</b></td>
<td>Single GPU only</td>
<td><b>Multi-GPU</b> with auto tabs when ≥ 2 devices detected</td></tr>

<tr><td>🔐 <b>Authentication</b></td>
<td>None (anyone with the URL gets in)</td>
<td><b>bcryptjs + JWT</b>, first user becomes admin</td></tr>

<tr><td>🔔 <b>Alerts</b></td>
<td>Front-end thresholds only</td>
<td>DB-backed rules, <b>sustain + cooldown</b> evaluator, in-app toasts, browser notifications, sound</td></tr>

<tr><td>📜 <b>Server logs</b></td>
<td>Plain log file</td>
<td><b>Filterable Logs page</b> (level / scope / search) + auto-refresh</td></tr>

<tr><td>🌍 <b>i18n</b></td>
<td>English only</td>
<td><b>EN / FR</b> shipped, scaffolded for more locales</td></tr>

<tr><td>🔄 <b>Update flow</b></td>
<td>Manual <code>docker compose pull</code></td>
<td>In-app <b>update banner</b> (GitHub + GHCR check) + standard Docker Compose update commands</td></tr>

<tr><td>🐳 <b>Image</b></td>
<td>Single-stage Python image</td>
<td><b>Multi-stage Node 22 Alpine</b>, multi-arch <b>amd64 + arm64</b>, healthcheck</td></tr>

</tbody>
</table>
</details>

Original work © bigsk1 (see [LICENSE](LICENSE)).

---

## License

GpuViewR is licensed under the **MIT License**, see the [LICENSE](LICENSE) file
for the full text.

```
Copyright (c) 2026 Erreur32  GpuViewR rewrite
                              https://github.com/Erreur32/GpuViewR
```

You are free to use, copy, modify, merge, publish, distribute, sublicense,
and sell copies of the software, subject to the license terms.

[![License](https://img.shields.io/badge/License-MIT-111827?style=for-the-badge&color=111827&labelColor=111827&logoColor=white)](LICENSE)

---

> 🛠 Want to hack on GpuViewR? See [`Docs/CONTRIBUTING.md`](Docs/CONTRIBUTING.md)
> for the local development setup, release flow, and architecture notes.
