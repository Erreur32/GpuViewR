# GpuViewR — NVIDIA GPU Dashboard

<div align="center">

<img src="public/gpuviewr.svg" alt="GpuViewR" width="128" height="128" />

![GpuViewR](https://img.shields.io/badge/GpuViewR-v0.1.0-111827?style=for-the-badge)
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

**Real-time NVIDIA GPU monitoring dashboard.**
Built with **React 19 · Vite · TailwindCSS · uPlot · Express 5 · WebSocket · better-sqlite3**.

[Quick start](#quick-start) · [First login](#first-login--there-is-no-default-account) · [Configuration](#configuration) · [Customizing](#customizing-the-look) · [Alerts](#alerts) · [Roadmap](#roadmap)

</div>

---

GpuViewR is a from-scratch reimplementation of GPU monitoring, focused on:

- ⚡ **Real-time** — WebSocket streaming, 1 s tick (no JSON polling)
- 🎨 **Modern UI** — Tailwind, 5 built-in themes (3 dark + 2 light), responsive mobile-first
- 📈 **Fast charts** — uPlot for smooth time-series streaming
- 🔘 **Switchable gauges** — arc rings or Grafana-style horizontal bars
- ✨ **Sparklines** in every gauge card
- 🔔 **Alerts engine** — sustained-duration thresholds, cooldown, browser notifications, optional sound
- 📜 **Filterable server logs** — level / scope / search, live auto-refresh
- 🌍 **i18n** — English / French out of the box, easy to extend
- 🔐 **Authentication** — first user becomes admin (bcrypt + JWT)
- 🔢 **Multi-GPU** — automatic tabs when 2+ devices are detected
- 🐳 **Single Docker image** — multi-arch (amd64 / arm64), Node 22 Alpine

---

## Credits

GpuViewR is a complete rewrite **inspired by and originally based on**
[**bigsk1/gpu-monitor**](https://github.com/bigsk1/gpu-monitor) (MIT License).

The original project provided the foundation: GPU data collection approach via
`nvidia-smi`, the SQLite schema for historical metrics, and the Docker
packaging strategy. GpuViewR keeps the data model compatible so existing
gpu-monitor users can migrate without losing their history (see
[`Docs/MIGRATION.md`](Docs/MIGRATION.md)).

### What changed in GpuViewR

<table>
<thead>
<tr>
  <th width="22%">Area</th>
  <th width="36%"><sub>🪦</sub> Original <code>gpu-monitor</code></th>
  <th width="42%"><sub>🚀</sub> GpuViewR</th>
</tr>
</thead>
<tbody>

<tr>
  <td>📡 <b>Data transport</b></td>
  <td>Polling <code>gpu_current_stats.json</code> every <b>5 s</b>, chart every <b>30 s</b></td>
  <td><b>WebSocket</b> streaming every <b>1 s</b>, auto-reconnect with backoff</td>
</tr>

<tr>
  <td>⚙️ <b>Collector</b></td>
  <td>Bash script (≈ 630 lines), <code>nvidia-smi</code> + intermediate JSON files</td>
  <td>TypeScript service, <code>nvidia-smi</code> spawned from Node, batched DB writes</td>
</tr>

<tr>
  <td>💾 <b>Storage</b></td>
  <td>SQLite (single GPU column), 24 h retention</td>
  <td>SQLite WAL + index per GPU, <b>7 d retention</b> (configurable)</td>
</tr>

<tr>
  <td>🎨 <b>Frontend</b></td>
  <td>One <code>gpu-stats.html</code> file, <b>1 183 lines</b> of inline HTML+CSS+JS</td>
  <td><b>React 19</b> + Vite + TailwindCSS, modular components, ~25 KB gzip</td>
</tr>

<tr>
  <td>📊 <b>Charts</b></td>
  <td>Chart.js <b>3.7</b> (≈ 195 KB)</td>
  <td><b>uPlot</b> (≈ 40 KB), built for live time-series</td>
</tr>

<tr>
  <td>🌈 <b>Theming</b></td>
  <td>One fixed dark palette</td>
  <td><b>5 themes</b> (3 dark + 2 light) via CSS variables, theme picker in Settings</td>
</tr>

<tr>
  <td>📐 <b>Gauges</b></td>
  <td>Static horizontal bars</td>
  <td><b>Arc rings or Grafana-style bars</b>, switchable; sparklines on every card</td>
</tr>

<tr>
  <td>🔢 <b>Multi-GPU</b></td>
  <td>Single GPU only</td>
  <td><b>Multi-GPU</b> with auto tabs when ≥ 2 devices detected</td>
</tr>

<tr>
  <td>🔐 <b>Authentication</b></td>
  <td>None — anyone with the URL gets in</td>
  <td><b>bcrypt + JWT</b>, first user becomes admin (no default credentials)</td>
</tr>

<tr>
  <td>🔔 <b>Alerts</b></td>
  <td>Threshold + browser notification (front-end only)</td>
  <td>DB-backed rules, <b>sustain + cooldown</b> evaluator, in-app toasts, browser notifications, optional sound</td>
</tr>

<tr>
  <td>📜 <b>Server logs</b></td>
  <td>Plain log file</td>
  <td><b>Filterable Logs page</b> (level / scope / search) + auto-refresh</td>
</tr>

<tr>
  <td>🌍 <b>i18n</b></td>
  <td>English only</td>
  <td><b>EN / FR</b> shipped, scaffolded for more locales</td>
</tr>

<tr>
  <td>🔄 <b>Update flow</b></td>
  <td>Manual <code>docker compose pull && up -d</code></td>
  <td>In-app <b>update banner</b> (GitHub + GHCR check) and <code>update.sh</code> helper with auto-backup &amp; rollback</td>
</tr>

<tr>
  <td>🐳 <b>Image</b></td>
  <td>Single-stage Python image</td>
  <td><b>Multi-stage Node 22 Alpine</b>, multi-arch <b>amd64 + arm64</b>, healthcheck included</td>
</tr>

</tbody>
</table>

Original work © bigsk1 — see [LICENSE](LICENSE) for the full notice.

---

## Quick start

### Docker (recommended)

```bash
# 1. Generate a JWT secret
echo "JWT_SECRET=$(openssl rand -base64 32)" > .env

# 2. (Optional) Pin the LAN IP that appears in the boot banner
echo "HOST_IP=$(hostname -I | awk '{print $1}')" >> .env

# 3. Start
docker compose up -d

# 4. Open the dashboard
#    http://localhost:7510
```

The first time you connect, the login page automatically switches to **"Create
admin account"**. The first user you register is granted the `admin` role.
Subsequent registrations create regular `user` accounts.

> Default Docker port is **`7510`** (host) → **`3015`** (container). Override
> the host port with `DASHBOARD_PORT=...` in `.env`.

### Local development (npm)

```bash
git clone https://github.com/Erreur32/GpuViewR.git
cd GpuViewR
nvm use                              # Node 22
npm install
cp .env.example .env && nano .env    # set JWT_SECRET
npm run dev                          # client + server in parallel
```

| Endpoint | URL |
|---|---|
| Frontend (Vite dev) | `http://localhost:5181` |
| Backend API | `http://localhost:3015/api` |
| WebSocket | `ws://localhost:3015/ws/gpu` |

The boot banner prints all four URLs, including a network-reachable variant
based on the detected LAN IP. If the configured port is already in use, the
backend exits with a clear, color-coded message rather than crashing later.

---

## First login — there is no default account

GpuViewR ships **without** any pre-baked credentials, on purpose:

1. The first time you reach `/login`, the API reports `hasUsers: false`.
2. The login form switches into **"Create admin account"** mode.
3. Pick your own `username` (≥ 3 chars) and `password` (≥ 8 chars).
4. The first user is created with role `admin` automatically.
5. Future registrations are regular `user` accounts.

**Lost your password?** The simplest path is to wipe the user store and start
over:

```bash
docker compose down
rm -rf ./data/gpuviewr.db*
docker compose up -d
```

(GPU history is stored in the same SQLite file, so it will be reset too. A
dedicated `npm run reset-password` helper is on the roadmap.)

---

## Configuration

All settings are read from `.env`. See [`.env.example`](.env.example) for the
complete list.

| Variable | Default | Purpose |
|---|---:|---|
| `JWT_SECRET` | — | **Required.** Secret for signing JWTs. Generate with `openssl rand -base64 32`. |
| `PORT` | `3015` | Backend HTTP/WebSocket port (inside the container in Docker). |
| `VITE_PORT` | `5181` | Vite dev server port (npm dev only). |
| `DASHBOARD_PORT` | `7510` | Docker only — host port mapped to the container's `PORT`. |
| `HOST_IP` | _auto_ | LAN IP shown in the banner. Auto-detected if unset. |
| `PUBLIC_URL` | — | If you serve GpuViewR behind a reverse proxy. |
| `TZ` | `Europe/Paris` | Container timezone. |
| `GPU_TICK_MS` | `1000` | How often `nvidia-smi` is sampled. |
| `RETENTION_DAYS` | `7` | How long historical metrics are kept. |
| `DATA_DIR` | `./data` | Where the SQLite DB lives. |

---

## Customizing the look

### Themes

Five themes ship by default: `Midnight`, `Graphite`, `Oceanic` (dark),
`Daylight`, `Paper` (light). Add a new theme by editing
[`src/lib/themes.ts`](src/lib/themes.ts) — each theme is a token map that's
applied to CSS variables on `<html>`:

```ts
export const THEMES: Theme[] = [
  // ...
  {
    id: 'sunset',
    label: 'Sunset',
    mode: 'dark',
    tokens: { /* bg, surface, accent, ok, warn, danger, ... */ },
  },
];
```

The new theme appears in **Settings → Theme** automatically.

### Gauges

Toggle between **arc rings** and **Grafana-style horizontal bars** from the
dashboard toolbar or **Settings → Gauge style**. The choice is persisted
per-browser in `localStorage`.

### Languages

Add a locale in [`src/i18n/locales/`](src/i18n/locales/) and register it in
[`src/i18n/index.ts`](src/i18n/index.ts). Missing keys fall back to English.

---

## Alerts

Define rules in **Alerts → New rule** (admin only). Each rule has:

| Field | Effect |
|---|---|
| Metric | `temperature`, `utilization`, `memory %`, `power`, `fan_speed` |
| Condition | `above` (≥) or `below` (≤) the threshold |
| Threshold | Numeric value |
| Sustained (s) | The threshold must be held for this long before firing |
| Cooldown (s) | Minimum gap between two firings of the same rule |
| GPU index | Empty = applies to all GPUs |
| Notify browser | Native `Notification` API |
| Notify sound | Plays `/alert.mp3` (replace the placeholder for a real tone) |

When a rule fires, GpuViewR pushes a `type: "alert"` frame on the same
WebSocket — the UI shows a toast immediately and (optionally) raises a browser
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

GpuViewR is licensed under the **MIT License** — see the [LICENSE](LICENSE) file
for the full text.

```
Copyright (c) 2024 bigsk1   — original gpu-monitor project
                              https://github.com/bigsk1/gpu-monitor
Copyright (c) 2026 Erreur32 — GpuViewR rewrite
                              https://github.com/Erreur32/GpuViewR
```

Both copyright notices must remain in the LICENSE file. You are free to use,
copy, modify, merge, publish, distribute, sublicense, and sell copies of the
software, subject to the license terms.

[![License](https://img.shields.io/badge/License-MIT-111827?style=for-the-badge&color=111827&labelColor=111827&logoColor=white)](LICENSE)
