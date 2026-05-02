# Changelog

All notable changes to GpuViewR are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6] - 2026-05-02

System tab, DB management UI, per-series chart colors, time format,
sound toggle relocation, schema migration and SonarCloud fixes.

### Added
- **System tab** in the header (next to Alerts) showing host hardware
  and runtime info: OS / kernel / arch / hostname / uptime / loadavg,
  CPU model + cores + base clock, memory total/used/free with a usage
  bar, Node process info (version, PID, RSS, uptime), and per-GPU
  details (UUID, driver, memory, temperature, utilization, power, fan,
  clocks). Polls `/api/system` every 10 s.
- **Database settings** in Settings: live stats (rows, file size on
  disk including WAL/SHM, oldest/newest sample, journal mode, pages),
  configurable retention (1-365 days, persisted in `app_config`,
  honored by the hourly retention job), admin-only purge buttons (purge
  beyond retention, wipe all) followed by `VACUUM` to reclaim disk.
- **Per-series chart colors**: each chip below the live chart now hosts
  a clickable color swatch opening the native color picker. Custom
  colors persist in `localStorage` and feed both the chart strokes/fill
  and the chip indicators. A small `×` next to each customized chip
  resets that color back to the theme default.
- **Time format toggle (24h / 12h)** in Settings, applied to the live
  chip timestamp and tooltip on the chart. New `src/lib/time.ts`
  exposes `fmtClock` and `fmtDateTime` helpers.
- **Stats card state colors**: the 4 stats cards (Temp / Util / Mem /
  Power) tint themselves green/amber/red based on the average value
  over the selected period. Memory avg is converted to pct using live
  `memory_total`. Healthy periods read all-green, warn/danger stand
  out at a glance.
- **Release notes in Settings > Updates**: the panel now displays the
  latest tagged version's release notes (GitHub release, fallback to
  local `CHANGELOG.md`) even when you are already up to date, with a
  "View on GitHub" link.

### Changed
- **Sound toggle moved** from Settings to the Alerts page header (next
  to "Enable browser notifications") since it gates alert sounds. Now
  shows `Sound ON` / `Sound OFF` with a mute icon.
- **Header**: removed the global LIVE / OFFLINE pill (per-gauge live
  indicators on the dashboard already convey freshness).
- **Footer**: removed the "inspired by bigsk1/gpu-monitor" line. The
  credit remains in the README only.
- **Update checker**: the cached check result is invalidated at boot if
  the running version no longer matches the cached `currentVersion`.
  Previously, after a version bump, the panel kept showing the old
  current/latest pair until the cache TTL elapsed.

### Fixed
- **GPU utilization stored as 0** when `nvidia-smi` reports `[N/A]`.
  Schema migrated: `gpu_metrics.utilization` now allows NULL (SQLite
  table-rebuild migration runs at boot if the column still has the old
  NOT NULL constraint). Live samples and historical reads now expose
  `null` and the UI renders `N/A` / `-` instead of a fake 0%.
- LiveChart: chart container is keyboard-accessible (role=button,
  tabIndex, Enter/Space toggle pin/unpin) instead of a click-only div.
- LiveChart: `ChipProps` is a `Readonly<…>` type alias instead of an
  interface.
- GaugeCard: extracted `Status` type alias (used in `statusFor`,
  `colorFor`, ArcGauge, BarGauge). `Props` is now `Readonly<…>`.
- StatsSection: removed two `void`-operator usages. The render-on-tick
  hook subscription is now a bare `useGpuStore(...)` call.
- Dockerfile: merged the runtime `apt-get install` RUN with the
  consecutive `mkdir -p /app/data && chown` RUN to reduce layer count.

### Performance
- SQLite tuned: `cache_size = -65536` (~64 MiB page cache), `mmap_size
  = 256 MiB`, `temp_store = MEMORY`. Existing pragmas (`WAL`,
  `synchronous = NORMAL`) and indexes (`timestamp_epoch`,
  `(gpu_index, timestamp_epoch)`) unchanged.

## [0.1.5] - 2026-05-02

Live chart usability and accurate utilization handling.

### Added
- **Interactive chart legend**: the Util / Temp / Power chips below the
  live chart are now clickable to hide / show each series. The chip dims
  and the label is struck-through when the series is hidden. Restores
  the toggle behavior expected from a chart legend.
- **Short ranges**: `1 min` and `2 min` join `5m / 15m / 1h / 6h / 24h /
  3d` for finer real-time monitoring. Server `parseRange` also accepts a
  `s` (seconds) suffix.
- **Settings > Updates**: the latest version's release notes (from the
  GitHub release, fallback to `CHANGELOG.md`) are now shown directly in
  the Updates panel, even when you are already on the latest version.
  Includes a "View on GitHub" link.

### Fixed
- **GPU utilization showing 0%** when `nvidia-smi` reports `[N/A]` for
  `utilization.gpu` (common on consumer cards in container/MIG/vGPU
  configs). The collector previously coerced `[N/A]` to `0`, which then
  poisoned Min / Avg / Max stats and the live gauge. Utilization is now
  nullable end-to-end (server, SQLite row type, store, UI) and displays
  `N/A` / `-` instead of a misleading `0%`.
- **Memory gauge layout**: the memory card now shows the used value on
  the main line (e.g. `4 MiB`) and `/ 8 192 MiB` on a secondary line,
  matching the layout of the other gauges. Driven by a new
  `displaySubValue` prop on `GaugeCard`.

### Changed
- `updateService.runCheck` now fetches release notes for the latest
  tagged version unconditionally so the Settings panel can display them.

## [0.1.4] - 2026-05-02

UX polish on the dashboard. The gauges feel live, the chart legend is
always populated, and the stats panel stays in sync with the live samples.

### Changed
- **Gauges**: removed the harsh outer drop-shadow glow on the arc rings.
  The arc now uses a subtle gradient stroke and shows two thin tick marks
  at the warn and danger thresholds so the bands are visible at a glance.
  Animation moved to a 600 ms cubic-bezier ease-out so changes feel like a
  real-time meter rather than a snap.
- **Gauge state colors** stay green / amber / red but the threshold ticks
  make the boundaries explicit (warn at 75 °C / 85 % util / 80 % mem / 250 W,
  danger at 85 °C / 95 % util / 92 % mem / 350 W).
- **Live tick indicator** added to each gauge header: a small dot that
  flashes briefly each time a new WebSocket sample lands. Confirms at a
  glance that the value is live, even when the metric itself is steady (idle
  GPU, stable temperature, etc.).
- **Chart legend** rebuilt as a row of always-visible chips above the
  plot. Each chip shows the metric color, label, and current value.
  - When the cursor is over the plot: chips show the value at the cursor
    and a timestamp pill replaces the LIVE badge.
  - When the cursor leaves the plot: chips switch back to the latest
    WebSocket sample and the LIVE badge returns.
  - Clicking the plot pins / unpins the cursor (toggle live freeze).
- **Stats panel** now polls `/api/gpu/stats` every 5 s instead of only
  re-fetching on range / GPU change, and blends the latest live sample into
  the displayed `min` / `max` / `avg`. The collector flushes its 1-Hz
  buffer to SQLite once a minute, so this blend keeps the cards in sync
  with the gauges between flushes.

### Fixed
- Built-in uPlot legend was disabled (it only showed values during hover
  and stayed empty otherwise). Replaced by the always-visible chip row
  above.

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

## [0.1.2] - 2026-05-02

### Fixed
- Docker image base switched from **Alpine (musl)** to **Debian slim (glibc)** to
  ensure `nvidia-smi` injected by the NVIDIA Container Toolkit is executable inside
  the container (fixes "GPU not detected" when device nodes are present but
  `nvidia-smi` cannot start).

### Changed
- Removed the `update.sh` helper; the UI and documentation now recommend the
  standard Docker Compose update flow:
  `docker compose pull && docker compose up -d`.

### Credits
- Project foundation inspired by [bigsk1/gpu-monitor](https://github.com/bigsk1/gpu-monitor):
  original data collection approach, SQLite schema, Docker packaging.
- Boot banner, release script and CI workflow patterns mirrored from
  [Erreur32/LogviewR](https://github.com/Erreur32/LogviewR).
