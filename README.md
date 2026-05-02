# GpuViewR: NVIDIA GPU Dashboard

<div align="center">

<img src="public/gpuviewr.svg" alt="GpuViewR" width="128" height="128" />

![GpuViewR](https://img.shields.io/badge/GpuViewR-v0.1.3-111827?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-DEVELOPMENT-374151?style=for-the-badge)
![Docker](https://img.shields.io/badge/Docker-Ready-1f2937?style=for-the-badge&logo=docker&logoColor=38bdf8)
![NVIDIA](https://img.shields.io/badge/NVIDIA-GPU-111827?style=for-the-badge&logo=nvidia&logoColor=76b900)
![React](https://img.shields.io/badge/React-19-111827?style=for-the-badge&logo=react&logoColor=38bdf8)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-111827?style=for-the-badge&logo=typescript&logoColor=60a5fa)
[![License](https://img.shields.io/badge/License-MIT-111827?style=for-the-badge&color=111827&labelColor=111827&logoColor=white)](LICENSE)

[![Build](https://img.shields.io/github/actions/workflow/status/Erreur32/GpuViewR/docker-publish.yml?style=for-the-badge&logo=github&logoColor=white&label=Build&color=111827)](https://github.com/Erreur32/GpuViewR/actions/workflows/docker-publish.yml)
[![CI](https://img.shields.io/github/actions/workflow/status/Erreur32/GpuViewR/ci.yml?style=for-the-badge&logo=github&logoColor=white&label=CI&color=111827)](https://github.com/Erreur32/GpuViewR/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/badge/CodeQL-active-brightgreen?style=for-the-badge&logo=github)](https://github.com/Erreur32/GpuViewR/security/code-scanning)
[![OSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Erreur32/GpuViewR?style=for-the-badge&label=Scorecard)](https://scorecard.dev/viewer/?uri=github.com/Erreur32/GpuViewR)
[![SonarCloud](https://img.shields.io/sonar/quality_gate/Erreur32_GpuViewR?server=https%3A%2F%2Fsonarcloud.io&style=for-the-badge&logo=sonarcloud&logoColor=white&label=Sonar)](https://sonarcloud.io/summary/overall?id=Erreur32_GpuViewR)
[![Snyk](https://img.shields.io/github/actions/workflow/status/Erreur32/GpuViewR/snyk.yml?style=for-the-badge&logo=snyk&logoColor=white&label=Snyk&color=111827)](https://github.com/Erreur32/GpuViewR/actions/workflows/snyk.yml)
[![Release](https://img.shields.io/github/v/release/Erreur32/GpuViewR?style=for-the-badge&logo=github&logoColor=white&label=Release&color=111827)](https://github.com/Erreur32/GpuViewR/releases)
[![GHCR](https://img.shields.io/badge/ghcr.io-erreur32%2Fgpuviewr-111827?style=for-the-badge&logo=docker&logoColor=38bdf8)](https://github.com/Erreur32/GpuViewR/pkgs/container/gpuviewr)

**Real-time NVIDIA GPU monitoring dashboard, packaged as a single Docker image.**

[Quick start](#quick-start) · [Configuration](#configuration) · [First login](#first-login) · [Customizing](#customizing-the-look) · [Alerts](#alerts) · [Roadmap](#roadmap)

</div>

---

## Features

- ⚡ **Real-time**: WebSocket streaming, 1 s tick (no JSON polling)
- 🎨 **Modern UI**: Tailwind, 5 built-in themes (3 dark + 2 light), responsive mobile-first
- 📈 **Fast charts**: uPlot for smooth time-series streaming
- 🔘 **Switchable gauges**: arc rings or Grafana-style horizontal bars
- ✨ **Sparklines** in every gauge card
- 🔔 **Alerts engine**: sustained-duration thresholds, cooldown, browser notifications, optional sound
- 📜 **Filterable server logs**: level / scope / search, live auto-refresh
- 🌍 **i18n**: English / French out of the box
- 🔐 **Authentication**: first user becomes admin (bcryptjs + JWT)
- 🔢 **Multi-GPU**: automatic tabs when 2+ devices are detected
- 🐳 **Single Docker image**: multi-arch (amd64 / arm64), Node 22 Debian slim

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

## Quick start

### Prerequisites

- A host with an **NVIDIA GPU** and the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
  installed (so containers can see `nvidia-smi`).
- Docker Engine 23+ with the Compose plugin.

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

### Step 2: drop in this `docker-compose.yml`

Save it next to your `.env`:

```yaml
services:
  gpuviewr:
    image: ghcr.io/erreur32/gpuviewr:latest
    container_name: gpuviewr
    restart: unless-stopped

    ports:
      - "${DASHBOARD_PORT:-7510}:3015"

    environment:
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required (see Step 1)}
      PORT: 3015
      DASHBOARD_PORT: ${DASHBOARD_PORT:-7510}
      HOST_IP: ${HOST_IP:-}
      CONTAINER_NAME: gpuviewr
      TZ: ${TZ:-Europe/Paris}
      GPU_TICK_MS: ${GPU_TICK_MS:-1000}
      RETENTION_DAYS: ${RETENTION_DAYS:-7}

    volumes:
      - ./data:/app/data    # persistent SQLite (users + GPU history + alerts)

    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, utility]
    runtime: nvidia

    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:3015/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s

    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

> A ready-to-copy version is also available in
> [`docker-compose.example.yml`](docker-compose.example.yml).

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
| `GPU_TICK_MS` | `1000` | How often `nvidia-smi` is sampled. |
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

---

## Roadmap

- Per-process GPU usage breakdown (`nvidia-smi --query-compute-apps`)
- Password reset CLI
- CSV export of historical metrics
- PWA (installable on mobile, offline shell)
- Email / webhook alert dispatchers (in addition to in-app + browser)

---

## License

GpuViewR is licensed under the **MIT License**, see the [LICENSE](LICENSE) file
for the full text.

```
Copyright (c) 2024 bigsk1    original gpu-monitor project
                              https://github.com/bigsk1/gpu-monitor
Copyright (c) 2026 Erreur32  GpuViewR rewrite
                              https://github.com/Erreur32/GpuViewR
```

Both copyright notices must remain in the LICENSE file. You are free to use,
copy, modify, merge, publish, distribute, sublicense, and sell copies of the
software, subject to the license terms.

[![License](https://img.shields.io/badge/License-MIT-111827?style=for-the-badge&color=111827&labelColor=111827&logoColor=white)](LICENSE)

---

> 🛠 Want to hack on GpuViewR? See [`Docs/CONTRIBUTING.md`](Docs/CONTRIBUTING.md)
> for the local development setup, release flow, and architecture notes.
