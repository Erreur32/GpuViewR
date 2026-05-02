# Changelog

All notable changes to GpuViewR are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-05-02

First public release of GpuViewR. From-scratch rewrite of
[bigsk1/gpu-monitor](https://github.com/bigsk1/gpu-monitor) using a modern
TypeScript stack: React 19 + Vite + TailwindCSS + uPlot on the front,
Express 5 + WebSocket + better-sqlite3 + bcryptjs + JWT on the back. Single
Docker image, multi-arch (amd64 + arm64), Node 22 Alpine.

### Highlights

- Live WebSocket streaming (1 s tick) with auto-reconnect.
- Five built-in themes (3 dark + 2 light), arc / horizontal-bar gauges,
  sparklines, multi-GPU tabs, range selector (5 min → 3 d), 24 h stats.
- Authentication: first user becomes admin (bcryptjs + JWT, no default
  credentials).
- Alerts engine with sustained-duration thresholds, cooldown, browser
  notifications, optional sound.
- Filterable Logs page (level / scope / search, live auto-refresh).
- In-app update banner powered by `/api/updates/check` (GitHub + GHCR);
  release notes pulled from GitHub Releases with `CHANGELOG.md` fallback.
- Boot banner with port-availability check, IP detection, color URLs.
- i18n: English / French shipped, scaffolded for more locales.

### Security
- Replaced **bcrypt** with **bcryptjs** (pure JS, API-compatible) to remove
  the transitive `@mapbox/node-pre-gyp` → `tar` chain. Dependabot was
  unable to apply the `tar` security advisory because `bcrypt@5.1.1` pinned
  `tar@^6.x` while the advisory required `tar@7.5.11`. bcryptjs has no
  native build, no `node-pre-gyp`, and no `tar` dependency: `npm ls tar`
  is now empty.
- Added security & quality CI workflows:
  - `codeql.yml`: JavaScript/TypeScript SAST (push, PR, weekly schedule)
  - `scorecard.yml`: OpenSSF Scorecard (publishes to scorecard.dev)
  - `snyk.yml`: Snyk Code (SAST), Snyk Open Source (deps), Snyk Container
    (Docker image), severity ≥ high
  - `sonarcloud.yml`: SonarCloud quality gate (uses `sonar-project.properties`)
- Added `.github/dependabot.yml`: weekly grouped npm bumps + GitHub Actions
  + Docker base image, all on Monday morning Europe/Paris.
- Added `.github/workflows/SETUP.md` documenting how to wire `SNYK_TOKEN`
  and `SONAR_TOKEN` and how to enable each scanner.

### Fixed
- Boot banner now prints the **host-mapped port** (`DASHBOARD_PORT`) when
  running in Docker, instead of the unreachable container-internal port.
  The banner also reads the host LAN IP via `HOST_IP` (with auto-detect
  fallback) so the URL it shows is openable from a browser.
- `getPublicUrl()` returned a localhost fallback that fooled the boot
  banner into showing `http://localhost:PORT` instead of the detected LAN
  IP. It now returns an empty string when `PUBLIC_URL` is unset.
- `.gitignore` rule `logs` was promoted to `/logs` so that
  `src/components/logs/` (which contains the front-end Logs page) is no
  longer accidentally ignored.

### Changed
- README rewritten for end users: dropped the local-development section,
  inlined a copy-paste-ready `docker-compose.yml`, added a step-by-step
  `.env` walk-through, kept the comparison-with-original table behind a
  collapsible `<details>` block, and made the License section explicit
  with the dual copyright. Hacking notes moved to
  [`Docs/CONTRIBUTING.md`](Docs/CONTRIBUTING.md).
- Comparison table rebuilt with a category column and emoji icons (Data
  transport, Collector, Storage, Frontend, Charts, Theming, Gauges,
  Multi-GPU, Authentication, Alerts, Server logs, i18n, Update flow,
  Image).
- Removed the *Architecture* file-tree section from the README: it was
  developer-facing noise that drifted out of sync each time a file moved.
- Default ports moved off the originals to avoid collisions with sibling
  Docker stacks (probed against the host first):
  - backend `3010 → 3015`
  - Vite dev `5180 → 5181`
  - Docker host `8081 → 7510`
- Replaced the old `scripts/bump-version.js` with a richer
  `scripts/update-version.sh` (LogviewR pattern). The new script updates
  `package.json`, `package-lock.json`, `Header.tsx`, README badges and
  `sonar-project.properties`; generates a `commit-message.txt` template;
  and supports `--tag-push` to commit + tag + push in one shot.

### Added
- **In-app update checker**:
  - `GET /api/updates/check` (cached per `frequencyHours`, `?force=true`
    bypass)
  - `GET /api/updates/config` and `PATCH /api/updates/config` (admin only)
  - SQLite-backed `app_config` key/value store
  - Frontend dashboard banner with **Copy update command** + dismiss
  - Modal showing release notes (GitHub Releases body, falls back to local
    `CHANGELOG.md`)
  - Settings panel toggle (admin only) for enable / frequency
- **5 themes** (`Midnight`, `Graphite`, `Oceanic` dark; `Daylight`, `Paper`
  light), CSS-variable based.
- **Switchable gauges**: arc rings or Grafana-style horizontal bars,
  toggleable from the dashboard or Settings.
- **Sparklines** in every gauge card (rolling 60-sample window).
- **Range selector** (5 min / 15 min / 1 h / 6 h / 24 h / 3 d) wired to
  `/api/gpu/history` and `/api/gpu/stats`.
- **Multi-GPU** dashboard tabs auto-shown when 2+ devices are detected.
- **Stats panel** rendered both as colored cards and as a detailed
  `min / avg / max` table.
- **Alerts subsystem** (DB-backed rules, sustain + cooldown evaluator,
  WebSocket toasts, browser notifications, sound).
- **Logs page** filterable by level / scope / search with live
  auto-refresh.
- **Settings page**: theme picker, gauge style, language, alert sound.
- **i18n** scaffolding (FR / EN currently).
- **GPU collector** via `nvidia-smi` (subprocess), 1 s tick, multi-GPU
  aware.
- **WebSocket** live streaming on `/ws/gpu` (token auth, exponential
  backoff client reconnect).
- **REST API**: `/api/auth/*`, `/api/gpu/*`, `/api/alerts/*`,
  `/api/updates/*`, `/api/logs`, `/api/health`.
- **Multi-stage Dockerfile** (Node 22 Alpine, multi-arch amd64 / arm64).
- **`update.sh`** with `--check` and `--rollback` (auto-backups +
  retention 10).
- **GitHub Actions**: `docker-publish.yml` (multi-arch GHCR) +
  `ci.yml` (build smoke test).
- **README badges**: project version, status, Docker, NVIDIA, React,
  TypeScript, license, Build, CI, CodeQL, Scorecard, SonarCloud, Snyk,
  Release, GHCR.

### Credits
- Project foundation inspired by [bigsk1/gpu-monitor](https://github.com/bigsk1/gpu-monitor):
  original data collection approach, SQLite schema, Docker packaging.
- Boot banner, release script and CI workflow patterns mirrored from
  [Erreur32/LogviewR](https://github.com/Erreur32/LogviewR).
