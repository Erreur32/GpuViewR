# Changelog

All notable changes to GpuViewR are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Replaced **bcrypt** with **bcryptjs** (pure JS, API-compatible) to remove
  the transitive `@mapbox/node-pre-gyp` → `tar` chain. Dependabot was
  unable to apply the `tar` security advisory because `bcrypt@5.1.1` pinned
  `tar@^6.x` while the advisory required `tar@7.5.11`. bcryptjs has no
  native build, no `node-pre-gyp`, and no `tar` dependency — `npm ls tar`
  is now empty.
- Added security & quality CI workflows (mirroring LogviewR):
  - `codeql.yml` — JavaScript/TypeScript SAST (push, PR, weekly schedule)
  - `scorecard.yml` — OpenSSF Scorecard (publishes to scorecard.dev)
  - `snyk.yml` — Snyk Code (SAST), Snyk Open Source (deps), Snyk Container
    (Docker image), severity ≥ high
  - `sonarcloud.yml` — SonarCloud quality gate (uses `sonar-project.properties`)
- Added `.github/dependabot.yml`: weekly grouped npm bumps + GitHub Actions
  + Docker base image, all on Monday morning Europe/Paris.
- Added `.github/workflows/SETUP.md` documenting how to wire the SNYK_TOKEN
  and SONAR_TOKEN secrets and how to enable each scanner.
- README header gained badges for CodeQL, OpenSSF Scorecard, SonarCloud, and
  Snyk so the security posture is visible at a glance.

### Documentation
- README header rebuilt with shields.io badges (version, status, Docker, NVIDIA,
  React, TypeScript, license, build status, CI status, latest GitHub Release,
  GHCR image), centered hero block, and a quick navigation row. The version
  badge is auto-updated by `scripts/update-version.sh` along with the other
  version markers.
- README polish: removed the `xdg-open` line from the Docker quick-start (URL
  is now shown as a comment), removed the duplicate `update.sh` bullet from
  the user-facing feature list (it's already covered in the *Updating*
  section), made the License badge clickable (links to LICENSE), and expanded
  the License section with the dual copyright block.
- Removed the *Architecture* file-tree section from the README — it was
  developer-facing noise that drifted out of sync with the codebase. The
  tree is still reachable via `Docs/CONTRIBUTING.md` and the source itself.

### Fixed
- `getPublicUrl()` returned a localhost fallback that fooled the boot banner
  into showing `http://localhost:PORT` instead of the detected LAN IP. It now
  returns an empty string when `PUBLIC_URL` is unset, and the banner uses the
  detected IP for the public URL row.

### Changed
- Replaced the old `scripts/bump-version.js` with a richer
  `scripts/update-version.sh`, mirroring the LogviewR pattern. The new script:
  - Updates `package.json`, `package-lock.json`,
    `src/components/layout/Header.tsx`, and matching version markers in
    `README.md`.
  - Generates (or refreshes) a `commit-message.txt` template.
  - Optional `--tag-push` flag does commit + annotated tag + branch & tag
    push in one shot — exactly what the GHCR publish workflow needs.
  - npm aliases preserved: `npm run version:bump <new_version>`.

### Added
- **In-app update checker**: new admin-facing module that polls GitHub for
  newer releases and verifies the matching image is published on GHCR.
  - `GET /api/updates/check` (cached per `frequencyHours`, `?force=true` to
    bypass)
  - `GET /api/updates/config` and `PATCH /api/updates/config` (admin-only)
  - SQLite-backed `app_config` key/value store
  - Frontend dashboard banner with **Copy update command** + dismiss
  - Modal showing release notes (GitHub Releases body, falls back to local
    `CHANGELOG.md`) and the `./update.sh` instructions
  - Settings panel toggle (admin-only) for enable / frequency
  - Falls back gracefully when no release is published yet
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
