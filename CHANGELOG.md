# Changelog

All notable changes to GpuViewR are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Boot banner** (LogviewR-style): boxed Unicode art with title, environment
  label, container name, and color-coded URLs for `Frontend WEB`,
  `Frontend Local`, `Backend API`, `WebSocket`. The banner is also written to
  the persistent log buffer so it shows up on the `/logs` page.
- **Port availability check** at startup. If the configured `PORT` is taken,
  the backend prints a red boxed error with a one-liner to free the port and
  exits with code `2` instead of crashing later.
- **Auto-detected LAN IP** in the banner (priorities `eth0/wlan0/enp.../ens.../eno...`,
  skips `docker*`, `br-*`, `veth*`, `virbr*`). Override with `HOST_IP` in
  `.env` for Docker deployments behind a reverse proxy.
- **5 themes** (`Midnight`, `Graphite`, `Oceanic` dark; `Daylight`, `Paper`
  light) selectable from `Settings → Theme`, applied through CSS variables.
- **Switchable gauges**: arc rings or Grafana-style horizontal bars,
  toggleable from the dashboard toolbar or `Settings → Gauge style`.
- **Sparklines** in every gauge card (rolling 60-sample window).
- **Range selector** (5 min / 15 min / 1 h / 6 h / 24 h / 3 d) wired to
  `/api/gpu/history` for the chart and `/api/gpu/stats` for the stats panel.
- **Multi-GPU**: dashboard tabs auto-shown when 2 or more devices are
  detected.
- **Stats panel**: 24-hour statistics rendered both as colored cards and as a
  detailed `min / avg / max` table.
- **Alerts subsystem**:
  - DB-backed rules (`/api/alerts/rules`), admin-only mutations.
  - Sustained-duration evaluator (only fires when the threshold is held N seconds).
  - Per-rule cooldown to prevent flapping.
  - Browser notifications + optional alert sound.
  - In-app toasts pushed via the existing GPU WebSocket.
- **Logs page**: filterable by level / scope / search, with live auto-refresh.
- **Settings page**: theme picker, gauge style, language, alert sound toggle.
- **i18n** scaffolding ready for adding new languages (FR / EN currently).
- **Authentication**: bcrypt + JWT, first user registered becomes admin.
- **GPU collector** via `nvidia-smi` (subprocess), 1 s tick, multi-GPU aware.
- **WebSocket** live streaming on `/ws/gpu` (auth via query token,
  exponential-backoff reconnect on the client).
- **REST API**: `/api/auth/*`, `/api/gpu/*`, `/api/alerts/*`, `/api/logs`,
  `/api/health`.
- **Multi-stage Dockerfile** (Node 22 Alpine, multi-arch amd64 / arm64).
- **`update.sh`** with `--check` and `--rollback` (auto-backups + retention 10).
- **GitHub Actions**: `docker-publish.yml` (multi-arch GHCR) + `ci.yml`
  (build smoke test).
- **Bump-version script**: `npm run version:patch|minor|major` updates
  `package.json`, `README.md`, and `Header.tsx` in one shot.

### Changed
- **Default ports** moved off the originals to avoid collisions with sibling
  Docker stacks: backend `3010 → 3015`, Vite dev `5180 → 5181`, Docker host
  `8081 → 7510`. The container-internal port matches the dev backend (`3015`)
  for parity.

### Credits
- Project foundation inspired by [bigsk1/gpu-monitor](https://github.com/bigsk1/gpu-monitor)
  — original data collection approach, SQLite schema, Docker packaging.
- Boot banner and CI workflow patterned on [Erreur32/LogviewR](https://github.com/Erreur32/LogviewR).

## [0.1.0] — TBD

First public release.
