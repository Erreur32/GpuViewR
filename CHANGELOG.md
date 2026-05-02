# Changelog

All notable changes to GpuViewR are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.11] - 2026-05-02

Memory series on the live chart, rolling 90s Live window, and a
proper logo in the header / login + a live footer.

### Added
- **Memory % series** on the live chart (utilization, temperature,
  power, memory). Color from `--gv-info` (cyan), gradient fill, chip
  legend, threshold line, cursor tooltip — all wired so the new
  series feels native.
- 4th color slot in every chart preset (Cyber, Sunset, Aurora, Royal,
  Graphite) and a 4th `ColorPicker` + `ThresholdField` in the
  "Custom" / "Chart thresholds" cards.
- **Live AppFooter**: connection pill (Wifi + pulse dot when online,
  WifiOff when not), GPU count, aggregate metrics across all GPUs
  (avg util · avg temp · total power), live clock honoring the
  user 24h / 12h preference, plus a GitHub link and the dynamic
  version.
- Header and login page now show the real `/GPUViewR.png` logo
  (replacing the generic Cpu icon).

### Changed
- **Live range is now a rolling 90-second window** instead of a
  fixed slice. Points older than `LIVE_WINDOW_S` slide off the left
  on every tick so the chart reads as a true real-time scope.
  Server `parseRange('live')` aligned to 90s so the history fetch
  returns just enough rows to seed the window.
- Cursor tooltip is offset further from the pointer (no more
  pointer overlap), with a wider min-width to fit the 4 metrics.
- **Frontend version is no longer hardcoded.** Vite injects
  `__APP_VERSION__` from `package.json` (declared in
  `src/vite-env.d.ts`); Header and Footer use it. The update
  script no longer touches `Header.tsx`.

### Notes
- The hotspot / CodeQL noise from previous runs is unchanged here;
  this release does not add any new flagged code.

## [0.1.10] - 2026-05-02

Polish on top of v0.1.9: navigation no longer interrupts the live
chart, new "Custom" tab for theme/gauge/curve colors, About is
prettier, plus a sweep of Sonar fixes.

### Added
- New **"Custom" tab** in Settings (renamed from "Theme") that groups
  the dark / light theme picker, the gauge style toggle (moved from
  General), and a brand new **Chart curves** card with five curated
  presets (Cyber, Sunset, Aurora, Royal, Graphite) plus per-metric
  color pickers and a "Reset to theme" action.
- About tab uses the real `/GPUViewR.png` logo, ships the same
  Release / Docker / NVIDIA / MIT / Scorecard / CodeQL / SonarCloud
  badges as the README, and opens straight on an expanded changelog
  viewer with proper colored markdown rendering (headings, lists,
  inline code, fences, separators).
- Updates tab gets a dedicated **Update banner** card with the
  show/hide toggle (persisted as `gpuviewr.update_banner_enabled`).
- `gpuStore` now caches fetched chart history per `gpuIndex|range`
  so the live chart paints instantly when the user returns to the
  Dashboard from any other tab.

### Changed
- The dashboard WebSocket (`useGpuStream`) is now mounted on
  `AppLayout` instead of `Dashboard`. Live samples keep flowing into
  the store while the user is on Settings / Alerts / Logs, so the
  live chart no longer shows a blank gap on return.
- Brand assets are now standardized: `GPUViewR.png` is the square
  logo (used in About thumbnail), `GpuViewR-Ban.png` is the wide
  banner (README hero), `gpuviewr.svg` for crisp rendering.

### Security / Code quality
- Sweep `parseInt` / `parseFloat` -> `Number.parseInt` /
  `Number.parseFloat` across `server/` and `src/`
  (Sonar `typescript:S7773`).

## [0.1.9] - 2026-05-02

Settings, chart polish, per-process GPU table, security hardening.

### Added
- **About tab in Settings**: logo, version (installed + latest), feature
  highlights, GitHub author + repo links, MIT license. Includes a
  dismissible update-banner toggle (persisted in `localStorage`) and an
  embedded changelog viewer with version selector reading
  `GET /api/info/changelog`.
- **Tabbed Settings layout**: General / Exports / Database / Updates /
  About, active tab persisted in `localStorage`.
- **Chart thresholds card** in the General tab: master toggle,
  per-metric value (utilization %, temperature °C, power W), per-field
  clear, restore defaults. Defaults: util=95, temp=83, pow=350.
- **Cursor tooltip** on the live chart showing date/time + visible
  curve values, with theme colors and 24h/12h aware formatting.
- **Modern gradient area fills** for utilization, temperature and power
  series.
- **Live (50s) range button** replacing 1m / 2m, with auto-migration of
  legacy localStorage values.
- **Per-process GPU table**: PID / process name / VRAM, polled every
  2.5s via `GET /api/processes[?gpu=<i>]`. Backed by a 1.5s in-process
  cache around `nvidia-smi --query-compute-apps`.
- **`/api/info/{changelog,readme}`** endpoints, whitelist-only and size
  capped.
- **SECURITY.md** with disclosure flow and supported versions.

### Changed
- Layout widened from `max-w-7xl` to `max-w-[1600px]` (header, main,
  Settings) for large monitors.
- Live chart x-axis now honors the user 24h / 12h preference and adds
  seconds when the tick spacing drops below one minute.
- WebSocket per-client connect/disconnect logs demoted to `debug`.
- `gpuStore.ingest` now produces immutable `Series` objects so the
  chart picks up live ticks without waiting for a range change.
- Dockerfile: `apt-get upgrade -y` in both stages and FROM lines pinned
  to `node:22-bookworm-slim@sha256:d415caac…`. Runtime image now also
  ships `README.md`.
- CI workflow actions pinned to commit SHAs.
- `release.yml`: top-level `permissions: read-all`, `contents: write`
  scoped to the `create-release` job only.
- `update-version.sh`: stop rewriting the static `GpuViewR-vX.Y.Z`
  README badge (replaced by the dynamic GitHub Release badge).

### Security
- **Rate limiting** (`express-rate-limit`): apiLimiter (600/min) on
  `/api`, authLimiter (10/min, brute-force window) on `/api/auth`,
  metricsLimiter (120/min) on `/metrics`. `trust proxy = 1` so
  `X-Forwarded-For` is honored behind a reverse proxy. Closes 11
  CodeQL "Missing rate limiting" alerts.
- **Prometheus label escaping**: backslash, quote and newline are now
  escaped on `name` and `uuid` labels (CodeQL #29).
- **MQTT clientId**: `Math.random()` replaced with `randomBytes(4)`
  (Sonar `typescript:S2245`).
- **InfluxDB URL placeholder**: `http://` → `https://` (Sonar
  `typescript:S5332`).
- **a11y**: paired `onKeyDown` with `onClick` on the chart color-picker
  label (Sonar `typescript:S1082`).
- **PATH hardening**: nvidia-smi spawns now use a fixed `PATH`
  (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`) so a
  malicious working directory cannot shadow the binary (Sonar
  `typescript:S4036`).
- **CORS**: replaced `cors()` with an origin allowlist (the configured
  public URL plus the Vite dev port in development), removing the
  permissive `Access-Control-Allow-Origin: *` (Sonar `typescript:S5122`).
- **Async safety**: explicit `!== null` guard on the in-flight cache
  Promise (Sonar `typescript:S6544`).

## [0.1.7] - 2026-05-02

Exports & integrations: Prometheus, MQTT (with Home Assistant
discovery), InfluxDB v2, and Webhook.

### Added
- **Prometheus exporter**: pull-based `GET /metrics` exposing
  `gpuviewr_gpu_temperature_celsius`, `gpuviewr_gpu_utilization_ratio`,
  `gpuviewr_gpu_memory_{used,total}_bytes`, `gpuviewr_gpu_power_watts`,
  `gpuviewr_gpu_fan_speed_ratio`, `gpuviewr_gpu_clock_{graphics,memory}_hz`
  with `gpu`, `name`, `uuid` labels per GPU. Endpoint returns 404 when
  the exporter is disabled (no scrape leakage).
- **MQTT exporter**: publishes one retained JSON message per GPU on
  `<topicPrefix>/gpu<N>/state` at configurable intervals. Supports
  username/password, custom topic prefix, and **optional Home Assistant
  discovery** which auto-publishes `homeassistant/sensor/.../config`
  topics so all GPU sensors register automatically in HA.
- **InfluxDB v2 exporter**: pushes line-protocol writes to
  `<url>/api/v2/write?org=&bucket=&precision=s` with `Authorization:
  Token ...`. Configurable measurement name and write interval.
- **Webhook exporter**: posts a JSON payload `{source, timestamp,
  samples}` to a configurable URL with custom method (POST/PUT) and
  headers, at a configurable interval.
- **Settings > Exports & integrations**: per-exporter form (enable
  toggle, URL, credentials, interval, exporter-specific options),
  "Send test" buttons that fire a one-shot push, and secret masking
  (passwords / tokens are returned redacted by the API and only updated
  when the user types a new value).
- **Roadmap section** in `README.md` reorganized into "Done" (Exports
  v0.1.7) and "Planned" (per-process breakdown, password-reset CLI,
  CSV export, PWA, email dispatcher, multi-host fan-out).

### Changed
- Server boot now calls `exportService.init()` and registers
  `app.use('/api/exports', ...)` (configs API) and
  `app.use('/metrics', ...)` (Prometheus). The SPA catch-all regex was
  updated so `/metrics` is not swallowed by the static fallback.
- New `mqtt` runtime dependency.

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
