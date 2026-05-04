# Changelog

All notable changes to GpuViewR are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.38] - 2026-05-04

Clearer PCIe wording on the System tab and a denser, more
readable bar mode. Plus a small UX fix: the "Degraded link" badge
was firing on idle GPUs because NVIDIA cards downshift the PCIe
gen at idle to save power — that is not a hardware fault.

### Changed
- **System "Effective bandwidth" → "Link bandwidth"** (FR:
  "Bande passante effective" → "Bande passante du lien"). The
  number was always the theoretical bandwidth at the *current*
  PCIe gen × width, not the live RX/TX throughput; the old label
  read like the latter. Added an inline hint explaining that the
  link gen drops at idle (ASPM) and is expected to sit below the
  max — for example 4.00 GB/s on a PCIe 4.0 ×8 GPU at idle, vs.
  15.76 GB/s under load.
- **"Degraded link" badge** (System and Dashboard) now triggers
  only on a lane *width* mismatch (real seating / BIOS issue).
  Lower current gen vs max is normal idle behaviour and no
  longer counts as a degradation. The same badge was also added
  to the Dashboard PCIe card for parity.
- **System bar mode is single-line per metric**: label, bar and
  value share one row instead of stacking the value above the
  bar. Bar height drops to `h-1.5`, the value gets `text-base`
  bold. Each metric saves a full text line of vertical space.
- **System gauge mode lays out Host / CPU / Memory on one row**
  on `xl` screens (≥1280 px), with Host taking 2/4 of the width
  for its three load-avg gauges, and CPU + Memory each 1/4. On
  `md` it falls back to "Host full width / CPU + Memory
  side-by-side", and on mobile to a single stacked column.

## [0.1.37] - 2026-05-04

Save a full row of vertical space on the dashboard by merging the
GPU header and the view/range controls onto a single line, and
harmonize the gauge/bar selector order across the dashboard and
system pages.

### Changed
- **Dashboard header is now one row**, not two. The previous
  layout had `[GpuTabs … Gauges/Bars Range]` on row 1 and the
  GPU name + `GPU #N · driver X.Y.Z` on row 2. Both are merged
  into a single `flex-wrap` row: identity on the left, multi-GPU
  tabs in the middle (when present), Gauges/Bars + Range
  selector pushed right via `ml-auto`. On narrow viewports the
  controls wrap below as before.
- **System page view selector** now reads Gauges left / Bars
  right, matching the Dashboard. Was Bars / Gauges, which broke
  muscle memory when switching between the two pages.

## [0.1.36] - 2026-05-04

Two visual polish fixes: shorter PCIe tiles and no more blink on
Stats cards every refresh.

### Changed
- **PCIe card tiles (RX, TX, Link bandwidth, Link) are now ~25 %
  shorter.** Padding tightened (px-2.5 py-1.5), value text drops
  from text-lg to text-base, the gap above the number is removed.
  The Link-bandwidth tile now puts `/ max X.XX GB/s` on the same
  flex row as the live value (same baseline) instead of a
  dedicated line below — cleaner read, less vertical bulk.
- **Stats cards (period min/avg/max) no longer flash "…" on every
  5 s refresh.** Switched to stale-while-revalidate: previous
  values stay rendered while the background fetch is in flight,
  and only get replaced when the new payload lands. The "…"
  placeholder disappears entirely; cells show "-" only on the
  very first paint before any data is available, or when a
  switch to a new gpu/range is in progress.

## [0.1.35] - 2026-05-04

Mark the per-pid CPU bookkeeping map as readonly to silence
SonarCloud's S2933 maintainability smell.

### Changed
- `ProcessCollector.cpuPrev` is now declared `readonly`. The
  reference is set once at construction and only the map's
  contents (entries) are mutated via `set` / `delete`, so the
  reassignment-prevention promise is correct and Sonar's
  `typescript:S2933` no longer flags it.

## [0.1.34] - 2026-05-04

Silence SonarCloud's S2245 PRNG hotspot on the mock GPU collector.

### Changed
- **`mockGpu.ts` no longer calls `Math.random()`.** All four
  cosmetic uses (jitter, fake CPU%/GPU%, process memory weights)
  now go through a tiny `rand01()` helper backed by Node's
  `crypto.randomInt`. Behaviour is identical (still mock data,
  still only active when `MOCK_GPU=1`); the change exists purely
  to keep `typescript:S2245` clean without per-call NOSONAR
  noise.

## [0.1.33] - 2026-05-04

Fix the *real* reason PCIe RX/TX stayed at "-", and beef up the
per-GPU process table with nvtop-equivalent columns.

### Fixed
- **PCIe throughput collector now actually runs.** `nvidia-smi -q
  -d PCI` was the previous command, but `PCI` is not a valid value
  for `--display`/`-d` (allowed list is MEMORY|UTILIZATION|ECC|
  TEMPERATURE|POWER|CLOCK|COMPUTE|PIDS|PERFORMANCE|
  SUPPORTED_CLOCKS|PAGE_RETIREMENT|ACCOUNTING|ENCODER_STATS|
  FBC_STATS|ROW_REMAPPER). The spawn exited non-zero and our
  callback returned silently, leaving the throughput map empty —
  hence the "always -" symptom. Switched to the unfiltered
  `nvidia-smi -q` dump, whose PCI section per GPU still includes
  the `Tx Throughput` / `Rx Throughput` lines we parse.
- **Spawn errors are now logged** (warn level) with the actual
  exit code and stderr, so any future regression surfaces in
  `docker compose logs` instead of a quiet failure.

### Changed
- **PCIe RX/TX show "0 KiB/s" when the driver returns nothing**
  (or zero) instead of a "-" placeholder, on user request.
  Visually matches nvtop's idle reading and conveys "we did
  measure, traffic is just nil".

### Added
- **Per-GPU "Processes using this GPU" table now mirrors nvtop's
  layout.** Adds three columns: Type (C / G / G+C badge sourced
  from `nvidia-smi pmon`), GPU% (per-process SM utilization,
  also from `pmon`), CPU% (sampled between refreshes from
  /proc/<pid>/stat utime+stime delta). The Process cell now
  shows the full /proc/<pid>/cmdline as a muted second line
  under the basename — so you see `ollama runner --port 36451`
  instead of just `ollama`.
- Mock GPU mode synthesizes type, command, cpu_pct and gpu_pct
  so dev/demo screens demonstrate the new columns.

## [0.1.32] - 2026-05-04

Make PCIe RX/TX actually populate when the bus-id formats between
the CSV query and `-q -d PCI` happen to differ, and warm-yellow the
process names in the per-GPU process table.

### Fixed
- **PCIe RX/TX stayed at "-"** when the CSV `pci.bus_id` returned by
  `--query-gpu` and the per-block header from `nvidia-smi -q -d PCI`
  disagreed on format (real driver inconsistency). The throughput
  parser now publishes each block under both its bus-id and an
  `idx:N` key (block order); the merge tries bus-id first and falls
  back to index. A one-shot diagnostic line in the gpu logs now
  reports the parsed map at startup so any remaining "-" values
  can be diagnosed without redeploying.

### Changed
- **Process names in the per-GPU "Processes using this GPU" table**
  render in warm yellow (var(--gv-warn)) so the eye finds the
  binary path quickly against the rest of the columns.

## [0.1.31] - 2026-05-04

System page: condense card metadata so bars/gauges dominate.

### Changed
- **Host / CPU / Memory cards** drop the 3-column label-value
  grid in favour of a single inline metadata line right of the
  title (Concept B). The body of each card now belongs to the
  bars/gauges, roughly halving the vertical footprint.
- **Per-GPU sub-cards** follow the same layout: identity (driver,
  PCIe link) on the title line; live readings (temp, power,
  fan, GR/MEM clocks, bus id, truncated UUID) condensed into one
  muted line under the title. Util/Memory bars sit immediately
  below — no more 6-cell grid above them.
- Memory bar gains a sub-line ("X used / Y total") so the
  removed grid info stays visible at a glance.

## [0.1.30] - 2026-05-04

PCIe RX and TX now show real, distinct, instantaneous traffic
instead of the same theoretical link capacity in both tiles.

### Fixed
- **PCIe RX/TX tiles were both showing the link's theoretical max
  bandwidth** (gen × width, in GB/s) — the same number, never
  changing, with the wrong unit. The collector now also runs
  `nvidia-smi -q -d PCI` per tick, parses the per-GPU `Tx/Rx
  Throughput` lines (NVML PCIe counter, sampled ~20 ms), and
  feeds real KiB/s into two separate tiles.

### Added
- **New "Link bandwidth" tile** alongside RX / TX / Link, showing
  the theoretical unidirectional maximum of the active link
  (still in GB/s) — what the previous RX/TX tiles were actually
  measuring. RX/TX values are auto-formatted (KiB/s → MiB/s →
  GiB/s) and fall back to "-" on cards where the driver returns
  N/A. EN + FR.

## [0.1.29] - 2026-05-04

Polish the Midnight and Graphite themes: cards stand out more,
header text is pure white, active nav link is more legible.

### Changed
- **Midnight & Graphite cards** now use a lifted, more opaque
  surface so they pop off the page gradient instead of blending
  into it. Borders bumped from ~5–6 % to ~9–10 % white opacity
  so card edges read clearly. The two `surface-alt` tones move
  with them so chips, segs and inputs keep enough contrast
  against the new base.
- **Header / body text on Midnight & Graphite** moves to pure
  `#ffffff`. Muted/dim grays shift up a notch so section
  subtitles stay distinguishable on the now-brighter cards.
- **Active nav link** (all themes) gets a stronger background
  mix (14 → 20 % accent) plus a 1 px inset accent ring, so the
  current page is unambiguous on dark themes without changing
  the layout.

## [0.1.28] - 2026-05-04

Split the combined Metrics tab and put the gauge style picker first
on the Customize page.

### Changed
- **Exports & integrations now has four sub-tabs** instead of three:
  Notification · Home Assistant · **Prometheus** · **InfluxDB**.
  The previous combined "Metrics" tab is gone — each backend has
  its own page so the labels and active-dot indicators reflect the
  exact exporter you are looking at. Existing users with the old
  `metrics` value in localStorage land on Prometheus by default.
- **Customize page reorders sections** so "Gauge style" (arc/bar)
  is the first section, above Theme and Chart palette. Faster
  access since it's the most-toggled setting.

## [0.1.27] - 2026-05-04

Show an at-a-glance "active" indicator on each Exports sub-tab.

### Added
- **Green status dot on the sub-tab labels** (Notification / Home
  Assistant / Metrics) when the underlying exporter(s) are active.
  Notification dots when the webhook is enabled, Home Assistant
  dots when MQTT is enabled and the broker is connected (uses the
  live `info.mqtt.connected` flag), Metrics dots when at least one
  of Prometheus or InfluxDB is enabled. Dot includes a `title`
  tooltip ("Active" / "Active and connected") and is hidden
  otherwise. EN + FR.

## [0.1.26] - 2026-05-04

Make the InfluxDB "Send test" report the real result instead of a
guaranteed success.

### Fixed
- **InfluxDB test now returns the broker's actual HTTP response.**
  The previous test delegated to the periodic push helper, which
  swallows HTTP errors (logs a warning) and bails out silently when
  no GPU samples have been collected yet — so the test always
  reported "OK" even with a wrong token, missing bucket, or
  unreachable URL. The dedicated test now sends a synthetic line
  directly, surfaces non-2xx responses with the Influx error body,
  and aborts after 8s with an explicit timeout message.

## [0.1.25] - 2026-05-04

Make the MQTT "Send test" button actually test the broker — and stop
masking the real reason behind a generic "Bad Gateway".

### Fixed
- **MQTT test now opens its own short-lived connection** instead of
  just polling `mqttClient.connected` on the long-running client.
  The previous behavior raced the background reconnect: clicking
  Test right after Save returned "MQTT client not connected"
  before the broker handshake had a chance to complete.
- **`POST /api/exports/:kind/test` no longer returns HTTP 502 on a
  failed test.** It always returns 200 with `{ ok, message }`; the
  client's `api()` wrapper was throwing on 502 with `res.statusText`
  ("Bad Gateway"), hiding the actual broker error (auth refused,
  connection refused, timeout, …). The UI now surfaces the real
  message via the existing `notify('warn', message)` branch.

## [0.1.24] - 2026-05-04

Give MQTT / Home Assistant its own settings sub-tab, with an in-app
walkthrough of the HA-side configuration.

### Added
- **New "Home Assistant" sub-tab** under Exports & integrations,
  separate from the generic Metrics sub-tab (which now only hosts
  Prometheus and InfluxDB). The MQTT block lives there alongside a
  collapsible "How to set this up on Home Assistant" panel
  describing the 5-step path: install Mosquitto add-on → create
  MQTT user → add MQTT integration in HA → fill the form here →
  sensors auto-appear under Settings → Devices & services → MQTT.
  EN + FR i18n included.

## [0.1.23] - 2026-05-04

Make long ranges (1h+) snappy by downsampling history server-side.

### Performance
- **Server-side bucket-average for the chart's history endpoint.**
  At 1Hz collection, `3d` returned ~259k rows (~30 MB JSON) which
  dominated load time on range switch. The endpoint now caps the
  payload to ~1800 points by averaging rows into buckets sized to
  the range: `1h` → 2 s buckets, `6h` → 12 s, `24h` → 48 s,
  `3d` → 144 s. `live` / `5m` / `15m` stay raw (under the cap).
  CSV export still streams full resolution.

## [0.1.22] - 2026-05-04

Make the chart's time window truly rolling for every range, not just
`live`.

### Fixed
- **Chart range now slides for all periods.** Previously only
  `live` (90s) trimmed old points from the left edge as new ones
  arrived; `5m`, `15m`, `1h`, `6h`, `24h`, `3d` kept the initial
  fetch's left boundary fixed and just appended new live data,
  so the visible window grew beyond the selected period over
  time (e.g. `5m` opened at 14:00 was showing 13:55→14:10 by
  14:10). The cutoff is now applied to every range using a
  client-side `rangeToSeconds()` that mirrors the server's
  `parseRange`, so the left edge advances in lockstep with the
  newest sample.

## [0.1.21] - 2026-05-04

Default the dashboard chart to **Live** on first run, and drop the
now-redundant 1m/2m migration shim.

### Changed
- Chart range defaults to `live` (was `1h`) for fresh
  installs. Users with an existing `gpuviewr.range` in
  localStorage keep their selection.
- The dedicated `1m`/`2m` → `live` migration (added in v0.1.9
  for upgrades from ≤ 0.1.8) is removed. Any unknown stored
  range now falls back to `live`, which subsumes the old
  migration with less code.

## [0.1.20] - 2026-05-03

Asset cleanup release: working alert sound, square favicon and a
70 % reduction of the public PNG payload.

### Fixed
- **Alert sound** now actually plays. The shipped
  `public/alert.mp3` was a 107-byte HTML placeholder; replaced
  with a real MP3 binary so `Audio('/alert.mp3').play()` decodes
  correctly. Browser autoplay policy still requires a user
  gesture before the first sound — clicking anywhere on the
  page once is enough.

### Changed
- **Favicon** now uses `public/logo.png` (256×256 square PNG)
  instead of the 1254×1254 `gpuviewr_logo.png`. Tab icon
  renders crisp at native size with no scaling.
- **Public PNGs optimized** with Lanczos downscaling +
  light unsharp mask + max PNG compression, no JPEG
  conversion so screenshot text stays pixel-sharp:
  - `GPUViewR.png` / `gpuviewr_logo.png`: 1.32 MB → 57 KB
    (1254² → 256²), −96 % each.
  - `GpuViewR-Ban.png`: 1.28 MB → 522 KB (1983×793 →
    1256×502), −59 %.
  - `CpuViewR_screnshot.png`, `gpuviewr_screnshot_v1.png`:
    948–952 KB → 510–519 KB (2560×1277 → 1920×958), −45 %.
  - `logo.png`, `logo_test.png`: 261 / 587 KB → 108 / 213 KB
    (836×660 → 512×404), −59 / −64 %.
  - Total `public/*.png`: 6.7 MB → 1.99 MB (−70 %).
- README points to `public/gpuviewr_screnshot_v1.png` (the
  previous `gpuviewr_screnshot.png` was deleted alongside the
  optimisation pass).

## [0.1.19] - 2026-05-03

PCIe connectivity panel on the dashboard and the System tab,
nav tweak (System next to Dashboard), Docker Compose hardening
fix, and a large SonarCloud cleanup pass (≈46 issues across
seven categories).

### Added
- **PCIe connectivity** for every detected GPU. The collector
  now queries `pci.bus_id`, `pcie.link.gen.{current,max}` and
  `pcie.link.width.{current,max}` from `nvidia-smi`. The server
  derives the effective unidirectional bandwidth (GB/s) from the
  PCI-SIG per-lane figures (gen 1 → 6).
- **Dashboard PCIe card** above the processes table: RX / TX
  (full-duplex symmetric figures) + link summary, with the
  bus id pinned in the header and a short note explaining the
  bandwidth is theoretical.
- **System tab "PCIe connectivity" panel** under each GPU. Big
  effective-bandwidth headline, slot + link rows, and an amber
  **Degraded link** badge with a tooltip when the active gen or
  width is below the GPU/slot maximum.

### Changed
- Header navigation: System tab moved next to Dashboard
  (Dashboard / System / Alerts / Logs / Settings).
- Mock GPU 1 (RTX 3060) now reports a degraded PCIe 3.0 ×8 link
  so the badge is visible in dev without a real GPU.

### Fixed
- **Docker compose**: the previous `cap_drop: [ALL]` was too
  aggressive — the official image's entrypoint uses `gosu` to
  drop privileges to the `node` user, which needs SETUID,
  SETGID, CHOWN, FOWNER and DAC_OVERRIDE. Without them the
  container looped on `error: failed switching to "node":
  operation not permitted`. We now drop ALL caps and explicitly
  cap_add the five the boot sequence actually needs;
  `no-new-privileges:true` stays on.

### Refactored (SonarCloud)
- 6 cognitive-complexity reductions: `alerts.ts` PATCH handler,
  `alertService.evaluate`, `exportService.sendWebhook`,
  `exportService.test`, `updateService.runCheck`,
  `logger.query`, `AboutSettings.renderBody`.
- 4 `void promise()` → `.catch(() => {})` so the unhandled-
  promise intent is explicit (UpdateBanner, UpdateSettings,
  AboutSettings).
- 4 optional-chain rewrites (connection, auth middleware,
  exportService ×2).
- 3 nested template literals extracted to local consts (gpu.ts
  CSV filename, exportService HTTP error formatter, Prometheus
  label assembly).
- 2 `(s|m|h|d)` regex alternations collapsed to character
  classes; `Array#sort` in logger now uses `localeCompare`.
- 2 `NaN` → `Number.NaN`; 2 lookup arrays (`VALID_CONDITIONS`,
  `LEVELS`) converted to `Set` with `.has()`.
- `void bootstrap()` replaced with top-level `await
  bootstrap()` (Node 22 + ESM), so any unhandled rejection
  bubbles to the runtime instead of being swallowed.
- `themes.ts`: extracted `makeTheme()` to deduplicate the 6
  theme entries flagged by Sonar (Duplicated Lines on New
  Code).
- A11y / readability polish: `<div role="group">` → real
  `<fieldset>` + `<legend>` on the System view-mode picker and
  the Logs level selector; renamed the local `KV` helper to
  `InfoField` so the React PascalCase rule no longer flags it;
  `replace(/\W+/g, '')` → `replaceAll`; `typeof window` →
  `typeof globalThis.window`; flipped a couple of negated
  ternaries to put the positive branch first.

## [0.1.18] - 2026-05-03

System tab redesign with bar/gauge switch, per-rule webhook toggle,
mock GPU data for dev, URL-based settings tabs, Paper Dark theme,
and a 5-band heat scale for usage indicators.

### Added
- **System tab overhaul**: machine vs GPU zones with coloured
  separators, CPU usage % computed server-side from delta of
  `os.cpus()` times, load average bars normalised to core count,
  per-GPU utilisation/memory progress indicators with a
  bar/gauge switch persisted in localStorage. Half-circle
  speedometer-style gauges with a 5-band heat gradient (blue →
  green → yellow → orange → red), gradient track on bars, soft
  pulse when value ≥ 90 %.
- **Per-rule webhook toggle** (`notify_webhook` column on
  `alert_rules`): enable/disable webhook dispatch per rule from
  the rules list **and** the editor; tooltips on the icon
  describe exactly what the webhook receives. Webhook payload
  fields are now selectable in metrics+generic mode (checkboxes
  in Settings → Exports).
- **Metric icons** in the alert rules list and presets modal
  (Thermometer / Activity / MemoryStick / Zap / Fan).
- **Mock GPU mode** for dev hosts without an NVIDIA GPU
  (`MOCK_GPU=1`): synthetic samples for two virtual devices and
  a few fake processes, with a **DEV** + **🧪 Fake stats** badge
  in the header. `tsx watch` now also reloads on `.env` changes.
- **URL-based settings tabs** (`/settings/<tabId>`) so deep links
  and refreshes land back on the right panel; auth state is now
  hydrated synchronously from localStorage so refreshing a sub-
  page no longer flashes a redirect to the dashboard.
- **Paper Dark theme**: forest-paper variant with deep moss
  greens, sage-mint text and an emerald accent.

### Changed
- Manual "Refresh" buttons removed from System, Logs, Database
  and Exports panels (auto-refresh covers them); only the
  semantically distinct "Re-check for updates" button stays.
- Theme picker cards are narrower (3/4/6-column grid) and use
  truncation for long labels.
- Tighter padding on the `.input` fields used for retention days
  and update frequency in Settings.
- "Server process" panel removed from the System tab (Node /
  PID / RSS were not actionable from here).
- README: ships the `docker-compose.yml` example inline (curl
  one-liner + collapsible block) with the new `/proc:/host/proc:ro`
  bind mount and `cap_drop: [ALL]` hardening.

### Fixed
- GPU utilisation values now display with two decimals so the
  numbers stop "shaking" between integer renders (especially with
  mock data).
- Memory cell on the System GPU card now shows `used / total`
  on two lines, the max in dim text.

### Security
- New `processCollector` reads `${HOST_PROC}/<pid>/cmdline` so
  the container can resolve GPU process names by bind-mounting
  `/proc` read-only instead of sharing the host PID namespace.
- Compose example dropped privilege escalation
  (`no-new-privileges:true`) and all capabilities (`cap_drop:
  [ALL]`).

## [0.1.17] - 2026-05-02

Stats / chart reorder around fan, CSV history export, exporter
"what's being sent" panel, password-reset CLI, settings polish.

### Added
- **Password reset CLI** (`scripts/reset-password.ts`, also
  `npm run user:reset-password`) for admins who lose web-UI
  access. Honors `DATA_DIR`, supports `--list`, masked prompt with
  confirmation, or non-interactive `--password=<value>`.
- **CSV history export**: streaming `GET /api/gpu/history.csv`
  (`gpu=<i>|all`) backed by `better-sqlite3` `iterate()`, with a
  "CSV" button next to the chart title. UTF-8 BOM for Excel
  compatibility and RFC-4180 escaping.
- **Exporter "What's being sent" panel** under each enabled
  exporter (Prometheus, MQTT, InfluxDB) showing the active
  endpoint and the exact list of metrics / topics / payload keys /
  HA sensors / tag+field keys. Sourced from a single
  `PROMETHEUS_METRICS` / `MQTT_PAYLOAD_KEYS` / `MQTT_HA_SENSORS` /
  `INFLUX_TAG_KEYS` / `INFLUX_FIELD_KEYS` catalog shared with the
  publishing code so the panel and the wire output can't drift.
- **Webhook custom headers editor** (generic type) so users can
  attach `Authorization` / `X-API-Key` / etc. to each request.
- **Notifications section** in `Settings -> General`: global sound
  toggle (`Volume2`/`VolumeX`) and a one-click "Enable browser
  notifications" button that surfaces the current permission
  state (granted / not asked / blocked / not supported).

### Changed
- **Dashboard order is now Temp - Util - Memory - Fan - Power**
  across the gauges above the chart (Fan card added, grid bumped
  to `lg:grid-cols-5`), the Statistics table, the chart legend
  chips and the cursor tooltip. Per-category colors preserved.
- **Footer aggregate pill** folds in average fan speed (skipped on
  GPUs that don't expose `fan_speed`), in the same global order.
- **Webhook push interval** is now visible for every webhook type
  in metrics mode (previously hidden for Discord/Telegram even
  though the server scheduled their pushes).
- **Notification icon** switched to `/GPUViewR.png` for parity
  with the rest of the branding.
- **`renderPrometheus`** now drives its `# HELP`/`# TYPE` block
  from the shared `PROMETHEUS_METRICS` catalog (output bytes
  identical, single source of truth).

### Fixed
- **`selectedGpu` persists across reloads** (key
  `gpuviewr.selected_gpu`); previously the dashboard always
  snapped back to GPU #0 on every page load.

## [0.1.16] - 2026-05-02

Fan as a first-class chart curve and stat tile, Royal palette shipped
as the new out-of-the-box default, and one-click classic alert presets.

### Added
- **Fan speed in the live chart**: 5th series on the % scale with its
  own legend chip, threshold line, color picker and a Stats tile.
- **Alert presets**: `GET /api/alerts/presets` and
  `POST /api/alerts/presets/install` endpoints, plus a "Presets" modal
  on the Alerts page that seeds 9 classic GPU rules (temp critical /
  high, VRAM saturated / high, power high, sustained 100% util, fan
  runaway / stalled, idle anomaly). Installed rules land disabled so
  the user reviews thresholds before arming them.

### Changed
- **Default chart palette is now Royal**: seeded once at first hydrate
  via a `chart_palette_initialized` flag in localStorage, leaving any
  pre-existing custom colors untouched on upgrade.

## [0.1.13] - 2026-05-02

UX polish: cleaner Updates tab, smarter chart tooltip, deterministic
"Check now" feedback.

### Changed
- **Updates tab**: dropped the redundant inline release-notes preview
  (the About tab is now the only place with the full changelog
  viewer). Replaced with a compact link card "Release notes · vX.Y.Z
  → View on GitHub".
- **Chart tooltip** is now anchored to the cursor with a flipping
  diagonal offset: it appears top-right of the cursor by default, but
  flips to the left when close to the right edge and below when close
  to the top, so it never overlaps the pointer or gets clipped.

### Fixed
- "Check now" button always shows a toast (4-6s):
  - `success` "You are up to date" / "GpuViewR vX.Y.Z is available"
  - `error` / `warn` with the failure reason
  Reads the value freshly returned by `check(true)` instead of
  re-reading the store, so a transient API failure no longer leaves
  the user staring at a silent button.

## [0.1.12] - 2026-05-02

Webhook overhaul (Discord / Telegram / Generic), Notification +
Metrics sub-tabs, and a clearer update-check UX.

### Added
- **Webhook types**: Generic (JSON POST/PUT), **Discord** (embed) and
  **Telegram** (HTML message via Bot API). Token / chat ID stored
  redacted in API responses.
- **Webhook modes**:
  - `alerts` — fires on every alertService transition (firing /
    resolved), with a colored summary embedded in the payload.
  - `metrics` — periodic push of the latest GPU samples (legacy
    behavior, still useful as a data sink).
- **Settings -> Exports tab is now split into two sub-tabs**:
  - **Notification**: the new Webhook block with type / mode
    selectors.
  - **Metrics**: Prometheus, MQTT/HA, InfluxDB. Active sub-tab is
    persisted in `localStorage`.
- **Update check** now toasts an explicit result on every manual
  recheck: "You are up to date", "GpuViewR vX.Y.Z is available", or
  an error toast — instead of staying silent.

### Fixed
- Webhook test endpoint now actually checks the remote `response.ok`
  and surfaces the HTTP status / body excerpt on failure (it used to
  resolve with `ok: true` even when the remote answered 4xx).
- Generic webhook strips a user-supplied `Content-Type` header to
  keep our JSON body intact.

### Inspiration
- The webhook architecture (type-aware sender, alert-event dispatch)
  is loosely inspired by the LogviewR `WebhookDispatchService`.

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
