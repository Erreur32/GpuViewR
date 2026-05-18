# Changelog

All notable changes to GpuViewR are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.7] - 2026-05-18

README polish pass driven by user feedback. Goal: lower density,
more visual, easier to scan for a first-time visitor.

### Added

- **GPU vendors + OS platforms icon block** under the AI / LLM
  banner: a 4-column table with NVIDIA, AMD, Linux (Tux), and
  Windows logos plus per-platform detection method (nvidia-smi +
  pmon / ROCm + sysfs amdgpu / systemd + Docker / Scheduled Task
  + PDH). Followed by a paragraph emphasising mixed-fleet support
  (any NVIDIA/AMD mix across Linux/Windows on a single hub).
- New SVG asset files in `public/icons/`: `nvidia.svg`, `amd.svg`,
  `windows.svg`, `linux.svg`. Same SVG paths as the in-app
  `IconRegistry.tsx` for the first three; Linux gets a Tux
  silhouette in Linux yellow (`#FCC624`).

### Changed

- **README sections "Configuration", "Add a remote host",
  "Architecture", "Troubleshooting" now collapsible** via
  `<details>` blocks. First-time visitors see a short scrollable
  page; advanced details are one click away.
- **Removed the "Switch vendor" subsection** from "Install":
  re-running `install.sh` auto-detects and updates
  `COMPOSE_PROFILES`, so the explicit subsection was redundant
  with the "Update" subsection above.
- **"Where it installs" simplified**: the original 3-step
  priority list + 3 worked examples was overkill. New version:
  one short paragraph saying "cd to where you want it, then
  run", one example, one sentence on the session-landing-dir
  fallback, one sentence on `GPUVIEWR_INSTALL_DIR` override.
- **All em-dashes (U+2014) replaced with proper punctuation** in
  the README. Most became commas; one became a semicolon. The
  em-dash is technically valid English typography but reads
  unevenly across rendering surfaces (GitHub web vs GitHub
  mobile vs raw text).

### Internal

- Build verified: `tsc --noEmit` 0 errors, `npm run build` green.
- No app code changes; only README + SVG asset additions. Bundle
  unchanged from v0.8.6 (189.4 KB).

### Upgrade

- Pulling v0.8.7 only affects what the README looks like on
  GitHub. No agent or hub redeploy needed.

## [0.8.6] - 2026-05-18

### Fixed

- **Windows installer was leaking the old node.exe + launcher.ps1
  on re-install.** `install.ps1` ran `Unregister-ScheduledTask`
  without stopping the task first. Effect: the SYSTEM-owned
  child processes (powershell.exe → node.exe) survived the
  unregister, kept the old env vars in memory, and continued
  reconnecting to the hub with the now-invalidated token after
  a rotate. Symptom: agent.log spammed with `code=4001
  Unauthorized` errors until the hub's "3 consecutive auth
  failures" giveup fired, host stayed offline even though the
  NEW node.exe started by the freshly-registered task was
  working fine.
  Fix in `install.ps1.tpl`:
  - `Stop-ScheduledTask` before `Unregister-ScheduledTask`.
  - Best-effort `Stop-Process -Force` on any node.exe /
    powershell.exe whose ExecutablePath or CommandLine matches
    the install dir — covers cases where Unregister or
    Stop-ScheduledTask leaked a child that wasn't reaped.
  - 800 ms sleep so the OS finishes process teardown before
    Register fires.
  - Same dance applied to the `-Uninstall` branch — keeps
    `Remove-Item -Recurse $InstallDir` from failing on a
    locked agent.log.

### Internal

- Verified locally: tsc 0 errors, vite build green, agent
  bundle 189.4 KB unchanged (no source code changes — only the
  install template).

### Upgrade

- Hub: `docker compose pull && up -d --force-recreate`.
- Existing Windows agents stuck offline after a token rotate
  (4001 Unauthorized in agent.log): one-time manual fix is
  ```powershell
  Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
  Stop-ScheduledTask -TaskName 'GpuViewR Agent'
  Start-Sleep -Seconds 3
  Start-ScheduledTask -TaskName 'GpuViewR Agent'
  ```
  From v0.8.6 onward, the installer handles this automatically
  on every re-run.

## [0.8.5] - 2026-05-18

### Added

- **Delete-host modal now shows a Windows uninstall command** —
  third tab next to Linux bash + Docker. Pasted in elevated
  PowerShell: downloads install.ps1, invokes it with `-Uninstall`,
  removes the Scheduled Task + `C:\ProgramData\GpuViewR-Agent`.
  Mirrors the hint install.ps1 prints at the end of a successful
  install. Mode picker now defaults to the host's reported
  `install_mode` so the user sees their platform's command first.

### Internal

- **`_installCommands.tsx` extracted** as a shared module for the
  install-command builders + `<InstallModePicker>` widget. The
  three modals that show install/uninstall commands (Add-host,
  Rotate-token, Delete-host) now consume the same source instead
  of duplicating the `curl`/`docker`/`windows` templates and the
  3-button SEG toggle JSX. Triggered by SonarCloud's 27 % duplicated-
  lines threshold on HostsSettingsTab.tsx after the v0.8.4
  RotateTokenModal added the same install commands EnrollHostModal
  already had.
- Exports: `InstallMode` (union type), `InstallCommandSet`
  (3-string interface), `buildInstallCommands(hubHttp, token)` →
  `InstallCommandSet`, `LABEL_KEY_BY_MODE` (i18n key map),
  `defaultModeFor(installMode)` → `InstallMode` (falls back to
  `'curl'`), `<InstallModePicker mode onChange />` component.

### Upgrade

- Hub: `docker compose pull && up -d --force-recreate`. Effect
  immediate on the next time a Delete or Rotate modal is opened.

## [0.8.4] - 2026-05-18

### Changed

- **Rotate-token modal now shows the full install one-liner for the
  3 supported platforms** instead of just the raw token. After a
  successful rotate, the modal renders a Linux-bash / Docker /
  Windows-PowerShell toggle (same as the Add-host modal) with the
  ready-to-paste install command pre-filled with the new
  `host_id.secret` composite. The mode toggle defaults to the
  host's reported `install_mode` so the user sees their own
  platform's command first.
  Use case: rotating a token on an existing agent generally means
  the operator needs to re-run the installer on the remote box.
  Pre-v0.8.4 the modal only showed the raw token, leaving the
  operator to either remember the install one-liner format or look
  it up in docs. The raw token is still available behind a
  collapsible `<details>` block for Ansible / custom-installer use.

### Internal

- `src/components/settings/HostsSettingsTab.tsx`:
    - `RotateInstallMode` type + `defaultRotateModeFor` helper.
    - `RotateTokenModal` rebuilt around the same `cmdByMode` /
      `labelKeyByMode` lookup tables the EnrollHostModal uses, so
      the two modals stay shape-aligned.
    - Modal grows to `max-w-2xl` (was `max-w-lg`) to fit the
      install command's wider mono-spaced layout.
- `src/i18n/locales/{en,fr}.json`:
    - `hosts.rotate_done_hint` rewritten to point at the new
      "copy command + re-run on host" flow.
    - New key `hosts.rotate_show_raw_token` for the collapsible
      raw-token block.

### Upgrade

- Hub: `docker compose pull && up -d --force-recreate` (or rerun
  install.sh). Effect immediate on next rotate.

## [0.8.3] - 2026-05-18

Two /fleet chart polish fixes from real-time testing on the
v0.8.2 deploy.

### Fixed

- **Live chart: "graph advances, new trait appears 1 s later".**
  When multiple hosts pushed samples at slightly different
  sub-second offsets (host A at t=10.0, host B at t=10.3, …),
  the unified `sortedT` had timestamps where each individual
  host had no sample. Pre-fix, we wrote `null` at those
  positions and uPlot BROKE the line — visually, the chart's
  X-axis advanced as soon as ANY host pushed but each host's
  curve only re-drew its segment when its own next sample
  landed on the unified timeline (~1 second behind). Fix:
  forward-fill the per-host series across the unioned
  timeline — each host's value is held until its next sample.
  Lines now scroll smoothly together. Leading positions before
  a host has any data stay `null` (honest "no data yet").
- **Live chart: X-axis showed HH:MM only (looked like 24h ticks)
  on the live range.** With `range='live'` (60 s of data),
  uPlot's default time-axis formatter sometimes settled on the
  HH:MM format the user has chosen in Settings → time-format,
  showing the same minute label across every tick. Now an
  explicit `axes[0].values` formatter renders HH:MM:SS in live
  mode (always meaningful sub-minute movement) and HH:MM in
  longer ranges. Honors the 12h / 24h user preference via
  `toLocaleTimeString({hour12})`.
- **Range switch (live ↔ 24h ↔ 1h) now rebuilds the chart.**
  The X-axis formatter is a closure that captures the current
  `range` at uPlot construction. Switching range without a
  rebuild left the closure stale. `seriesShape` rebuild key now
  includes `range` + `timeFormat` so a switch triggers a
  destroy + recreate.

### Internal

- `src/components/fleet/FleetChart.tsx`:
    - `data` useMemo: per-host forward-fill loop (was
      `map.get(t) ?? null`, now hold last non-null value).
    - `ChartPlotProps` gains a `range: string` prop, threaded
      through from the parent.
    - X-axis `values` formatter added with range-aware
      granularity + `timeFormat` honoring.
    - `seriesShape` key includes range + timeFormat.

### Upgrade

- Hub: `docker compose pull && up -d --force-recreate` (or
  `install.sh`).
- Effect immediate on /fleet — no operator action.

## [0.8.2] - 2026-05-18

Three independent items shipped together:

### Fixed

- **Windows auto-update was failing with `EPERM: operation not
  permitted, fsync`.** First real `agent_update` push to a Windows
  agent (v0.6.9 → v0.8.0 from the .210 lab hub) surfaced the bug:
  `agent/src/transport.ts:347` opened the staged
  `agent.mjs.pending` file with `'r'` (read-only) then called
  `fsyncSync` on the fd. On POSIX this works; on Windows the
  `FlushFileBuffers` Win32 call underlying Node's fsync requires
  `GENERIC_WRITE` access on the handle. Result: the swap aborted
  before `agent.mjs.pending` was visible to launcher.ps1, the
  agent stayed on its old version, and the hub kept seeing the
  pre-update `hub_version` on reconnect.
  Fix: open with `'r+'` (read+write) — works cross-platform, fsync
  flushes the buffers as intended on both Linux and Windows.

### Added

- **`SYS_PTRACE` cap on agent docker sidecars (master + standalone
  composes).** Lets the agent's process collector read
  `/proc/<pid>/{cmdline, comm, stat}` for processes owned by other
  UIDs (e.g. ollama running as the system `ollama` user while the
  agent container runs as root). Without it the agent only resolves
  same-UID processes and falls back to "unknown" + missing CPU%.
  User had asked: "alternative si tu ne veux pas dérooter Ollama,
  une seule ligne sur l'agent". This is that line, applied to all
  three agent compose files (master `agent-nvidia`/`agent-amd` and
  the two standalone `docker-compose.agent.{amd,nvidia}.yaml`).

### Changed (UI cleanup)

- **/fleet "Tous hôtes" mode toggle removed.** User feedback: "le
  bouton tous hôtes je ne vois pas l'intérêt". The fleet-wide
  aggregated view (one curve per metric, summed/maxed/averaged
  across hosts) was rarely consulted; the per-host view with
  v0.8.1's colour-shaded metrics already conveys per-host detail
  clearly. Removed the toggle + `aggregateForTotal` helper +
  `METRIC_AGGREGATION` table + the unused `Mode` type. ~80 LOC
  out. If anyone asks for it back we restore from git history.

### Upgrade

- Hub: `curl …/install.sh | bash` (or `docker compose pull && up
  -d --force-recreate`).
- Windows agents currently on v0.6.9: click "Maj" again in the
  Hosts settings — this time the fsync swap will succeed and
  launcher.ps1 will pick up the new bundle within ~5 seconds.
- Agent docker users with non-root ollama (or any non-root
  GPU process): the new `SYS_PTRACE` cap is applied on the next
  recreate. Re-pull the compose via install.sh to pick it up.

## [0.8.1] - 2026-05-18

### Changed

- **/fleet per-host chart: metric distinguished by colour shade
  in addition to line width.** v0.8.0 introduced host-coloured
  curves but the 3 metrics for the same host shared the exact
  same hue, distinguished only by stroke width. On a single host
  the three lines packed close together and the widths weren't
  enough to read at a glance. v0.8.1 layers an HSL lightness
  shift on top:
  - utilization: base host colour (the headline number)
  - temperature: same hue + ~18 % lighter
  - power: same hue + ~18 % darker
  Combined with the existing per-metric widths (util 2.25 / temp
  1.5 / power 1.0), the three metrics for the same host now read
  as a clear colour family — same hue, different shade and
  weight. Pre-computed once at module scope (10 hosts × 3
  metrics = 30 cache entries) so no per-render colour math.
  Tooltip line previews follow the same shading.

### Internal

- `src/components/fleet/FleetChart.tsx`: new
  `METRIC_LIGHTNESS_DELTA` table, `hexToRgb` / `rgbToHsl` /
  `hslToRgb` / `rgbToHex` helpers, `hostMetricColor(hostIdx,
  metric)` with a module-scoped cache. Two call sites swapped
  from `hostColor(idx)` to `hostMetricColor(idx, metric)`.

## [0.8.0] - 2026-05-18

Closes two long-standing /fleet bugs the user surfaced after the
v0.7 marathon: the master never appeared on 1h/24h charts, and the
multi-host visual was unreadable above 2 hosts. Minor bump because
local samples now persist (changes what `gpu_metrics` contains).

### Fixed

- **Master host missing from /fleet chart on 1h/24h ranges.**
  Root cause: `agentMetricsPersistor.ts:38` skipped every sample
  with `host_id === LOCAL_HOST_ID`. That skip was defensive code
  from v0.4 where the hub had its own gpuCollector that persisted
  local samples inline before re-emitting them on the bus — the
  skip prevented double-writes. v0.5 removed gpuCollector
  entirely; the local sidecar has been the ONLY producer of local
  samples since. The skip turned out to be silently dropping
  every local sample from `gpu_metrics`. Live charts didn't show
  the symptom (they read from the in-memory store); 1h/24h charts
  did (they read SQLite history that was being skipped).
  Removed the skip; updated the unit test that asserted the old
  behaviour to assert the new one.

### Changed

- **/fleet per-host chart: color = host, not metric × dash.**
  Pre-v0.8 design painted each curve in the metric's colour
  (blue=util, orange=temp, blue=power) and distinguished hosts
  via a dash pattern (solid for host 0, long-dash for host 1,
  dotted for host 2…). Two issues: above 2 hosts the dashes
  became hard to track, and the user explicitly called the look
  "moche". New design uses a 10-color palette indexed by host
  (host 0 = blue, host 1 = green, host 2 = orange, …), all curves
  SOLID, and the three metrics for the same host share that
  host's colour. Metric distinction is now line WIDTH —
  utilization 2.25px (headline), temperature 1.5px, power 1px.
  - "Total" mode (aggregated single-curve-per-metric) keeps the
    metric-coloured behaviour since there's no host distinction
    to convey.
  - The metric toggle chips show line-width previews instead of
    colour dots in per-host mode.
  - The per-host legend below the chart now uses a solid colour
    swatch matching the host's chart curve.
- **Local samples persist to `gpu_metrics`.** Operators upgrading
  from v0.5+ will see their hub's history table grow with the
  local sidecar's samples for the first time since v0.5. Retention
  job continues to enforce `RETENTION_DAYS` (default 7), so
  long-term DB growth is bounded.

### Internal

- `server/services/agentMetricsPersistor.ts`: removed
  `LOCAL_HOST_ID` import + skip + comment.
- `server/services/agentMetricsPersistor.test.ts`: renamed the
  test from "are skipped" to "ARE persisted", flipped its
  assertion from "must not be re-persisted" to "+1 row +1
  device".
- `src/components/fleet/FleetChart.tsx`: dropped `HOST_DASH`
  array, added `HOST_PALETTE` (10 colors) + `hostColor(idx)` +
  `METRIC_WIDTH` (per-metric stroke width). Renamed
  `HostDashSwatch` → `HostColorSwatch`. Updated header comment
  block, metric chip rendering, ChartPlot stroke selection,
  tooltip rendering, legend swatch.
- `tsc --noEmit` still passes with 0 errors; `npm run build`
  green; 19/22 tests pass (3 pre-existing migration test
  failures unchanged).

### Upgrade

- Hub: `docker compose pull && docker compose up -d --force-recreate`
  (or `curl …/install.sh | bash`).
- Master row on /fleet's 1h/24h chart starts populating from the
  moment the new hub takes a sample — older "missing" period
  before the upgrade stays empty.
- Visual change is immediate; no operator action.

## [0.7.7] - 2026-05-18

Closes the loop on Palier 3 — the LLM badge tooltip now shows
friendly model names (`llama3.1:8b`) instead of cryptic sha256
prefixes for Ollama processes.

### Added

- **Ollama model-name resolution.** New
  `agent/src/collectors/ollamaManifests.ts` walks the Ollama
  manifests tree (`<ollama>/manifests/<registry>/<library>/<model>/<tag>`)
  on agent boot, parses each manifest JSON, and indexes the model-
  layer digest (`mediaType:
  application/vnd.ollama.image.model`) → tag name (e.g.
  `llama3.1:8b`). The Ollama branch of the LLM classifier now
  consults this resolver to translate the sha256 blob path
  surfaced in the runner cmdline. Falls back to `sha256:<prefix>`
  when no manifest matches (model pulled outside Ollama, or
  resolver disabled). Refreshes every 5 min so newly-pulled
  models become resolvable without an agent restart.
- **Discovery is automatic with a configurable override.** Probes
  these paths in order:
  1. `$OLLAMA_MANIFESTS_DIR` (explicit override)
  2. `/host/ollama/manifests` (docker bind-mount)
  3. `/usr/share/ollama/.ollama/manifests` (systemd default)
  4. `$HOME/.ollama/manifests`
  5. `/root/.ollama/manifests`
  First existing dir wins. Boot log line reports the chosen path
  + indexed manifest count.

### Changed

- **`docker-compose.yaml` adds opt-in Ollama bind-mount.** Both
  sidecars (nvidia + amd) now have a commented `${OLLAMA_DIR:-…}:/
  host/ollama:ro` volume entry. Operators uncomment + set
  `OLLAMA_DIR` in `.env` to enable model resolution. Left
  commented to avoid auto-creating empty directories on hosts
  without an Ollama install. Standalone agent composes get the
  same treatment in a follow-up if anyone asks.

### Internal

- `agent/src/collectors/llmClassifier.ts`: new optional
  `LLMResolvers` param threaded through `Pattern.model` callbacks.
  The Ollama pattern uses it to resolve the digest;
  other runtimes ignore it. API stays backwards-compatible —
  classifier called without resolvers still works (returns
  sha256:prefix for Ollama).
- `agent/src/index.ts`: instantiates one `OllamaResolver` at boot,
  passes it through to both `createProcessCollector` and
  `createRocmProcessCollector` via a new `llmResolvers` option.
  setInterval refresh on a 5-min schedule, `unref()`'d so the
  refresh doesn't keep the process alive past a graceful shutdown.
- `agent/src/collectors/processes.ts` + `processesRocm.ts`: pass
  the resolver through to `classifyLLM`.
- Bundle: 185.5 KB → 189.4 KB (+3.9 KB).

### Upgrade

- Hub: `docker compose pull && docker compose up -d
  --force-recreate` (or rerun `install.sh` for the polite prompt
  flow).
- To get friendly model names in the Ollama badge tooltip,
  uncomment the `ollama` volume in your `docker-compose.yaml`
  agent service and set `OLLAMA_DIR` in `.env` to your ollama
  dir on the host (most common: `/usr/share/ollama/.ollama` or
  `/root/.ollama`).
- Without that mount, the feature degrades gracefully — badges
  still appear, just with the sha256 prefix as the model id.

## [0.7.6] - 2026-05-18

### Internal

- **`tsc --noEmit` now passes with zero errors at repo root**
  (was 4 → 2 after v0.7.0's JSX namespace fix → 0 here):
  - `server/routes/alerts.ts` L92/L104/L177 — cast `req.params.id`
    to `string` to match the codebase pattern in
    `server/routes/hosts.ts:143`. Express's untyped `Request<>`
    generic widens params to `string | string[]` even though path
    params are always strings at runtime.
  - `server/services/authService.ts` L31 — replaced the `as
    JwtPayload` cast with a defensive runtime narrowing:
    `jwt.verify` returns `string | JwtPayload`, we now reject
    string payloads + validate the field shape (`sub` number,
    `username` string, `role` admin|user) before returning. Hardens
    against tokens signed with the same secret but different
    payload shapes (cross-app reuse, future schema migration).
- Reasoning for the cleanup: `npx tsc --noEmit` is now a useful
  pre-push signal again — any error is genuinely from the current
  change set, not noise to filter out.

## [0.7.5] - 2026-05-18

### Fixed

- **"Update now" button + auto-update toggle now enabled for Windows
  hosts.** v0.6.9 plumbed `install_mode='windows'` through the
  backend's `forceAgentUpdate` and `maybePushAutoUpdate` paths but
  the UI checks in `HostsSettingsTab.tsx` were still hardcoded to
  `host.install_mode === 'systemd'`, so both controls stayed grey
  on Windows host rows. Replaced both call sites with a new
  `isAgentSelfUpdatable()` helper that mirrors the backend check
  (`'systemd' || 'windows'`). Windows agents installed via
  `install.ps1` now show the same green toggle + clickable update
  button as systemd agents.

## [0.7.4] - 2026-05-18

Makes `install.sh` safe to re-run on existing installs — necessary
fallout from v0.7.3's container rename. Now respects operator
customisations and asks before doing anything destructive.

### Added

- **`install.sh` is now polite on re-runs.** Pre-v0.7.4 the
  installer silently overwrote `docker-compose.yaml` and silently
  recreated all containers. Now:
  - **Compose file:** if `docker-compose.yaml` already exists, the
    script fetches main's version into a temp file, compares them
    with `cmp`, and:
    - identical → "already up to date", no prompt
    - different → prints a `diff -u | head -40` then prompts. On
      Y, backs up the current file to
      `docker-compose.yaml.bak.<timestamp>` before replacing.
      On N, keeps the existing file and prints the upstream URL
      so the operator can merge manually.
    - non-interactive (no `/dev/tty`) → defaults to N, prints the
      URL for manual fetch.
  - **Stack recreate:** if any container in the project is
    detected (`docker compose ps -q`), the script lists them and
    warns before running `up -d --force-recreate --remove-orphans`
    — the user sees what will be replaced, the ~5-10 s downtime
    expectation, and that the `./data` volume is preserved. On N,
    aborts cleanly and prints the manual command. On a fresh
    install (no containers yet) no warning fires.
- **`docker compose up -d --force-recreate --remove-orphans`** as
  the actual recreate command (when accepted). `--force-recreate`
  picks up compose-level changes the image hash alone wouldn't
  trigger (container renames, volume adds, env-var adds);
  `--remove-orphans` cleans up containers whose names no longer
  match the current compose (e.g. pre-v0.7.3
  `gpuviewr-agent-local`).

### Upgrade path for v0.7.3 and earlier

```bash
curl -fsSL https://raw.githubusercontent.com/Erreur32/GpuViewR/main/install.sh | bash
```
The installer:
1. Detects existing install dir + .env.
2. Diffs your `docker-compose.yaml` against main, prompts to
   overwrite (backup made if you accept).
3. Detects running stack, prompts to force-recreate.
4. Pulls images, recreates, removes orphans.

If you have a custom `docker-compose.yaml` you want to keep,
answer N at step 2 — the installer will keep your file and the
recreate at step 3 will use it.

## [0.7.3] - 2026-05-18

Palier 3 — LLM-aware process classification (the AI/LLM banner in
the README finally pays off in the UI). Plus a small but breaking
container rename for clarity.

### Added

- **LLM runtime classification on GPU processes.** New
  `agent/src/collectors/llmClassifier.ts` runs over every GPU
  process command line and identifies the inference stack it
  belongs to:
  - **Ollama** — both the user CLI (`ollama run llama3:8b`) and
    the internal runner (`/usr/bin/ollama runner --model
    <blob-path>`). For runner processes we surface the blob's
    sha256 prefix as a model id (resolving the friendly name
    requires reading `~/.ollama/manifests/`, deferred to a
    later release).
  - **llama.cpp** — `llama-server`, `llama-cli`, `llamafile`,
    plus `main`/`server` binaries that take `-m *.gguf`.
  - **vLLM** — `python -m vllm.…`, model from `--model`.
  - **KoboldCpp** — `koboldcpp.py` / `koboldcpp_*.exe`.
  - **oobabooga** (text-generation-webui) — `server.py
    --model`.
  - **ComfyUI** — directory-based detection.
  - **Stable Diffusion WebUI** (Automatic1111) — `webui.py`
    inside a `stable-diffusion-webui` checkout.
  - **LM Studio** — `lms server` and the Electron helper.
  Wire frame: two new optional fields on `AgentGpuProcess` and
  on the hub-side `GpuProcess` type — `llm_runtime?: string |
  null` and `llm_model?: string | null`. Backwards-compatible
  with older agents (fields stay null).
- **LLM badge in the process table.** New `<LlmBadge>` next to
  the process name shows the runtime in info-blue (e.g.
  "Ollama", "vLLM", "llama.cpp"). Hover for the model id when
  known (e.g. `Ollama — sha256:a3de86cd1c13`). Vendor-correct
  casing comes from a UI-side label map so adding a new runtime
  in the agent's classifier is non-breaking.

### Changed (breaking for local scripts)

- **`gpuviewr-agent-local` renamed to `gpuviewr-hub-agent`.**
  The old name was ambiguous on multi-host setups: "local to
  what?". The new name is explicit — this is the agent that
  ships with the hub stack, distinct from `gpuviewr-agent`
  containers spun up on remote machines via the standalone
  composes. **Operator action required**: any script that does
  `docker exec gpuviewr-agent-local …` or `docker logs
  gpuviewr-agent-local` must be updated. After
  `docker compose up -d --force-recreate` the new name is in
  effect immediately; the old container is automatically removed.

### Internal

- Agent bundle: 181 KB → 185.5 KB (+4.5 KB for the classifier).
- Hub `GpuProcess` type extended in `server/services/
  _processTypes.ts`. Hub passes the fields through unchanged;
  no DB schema change (processes aren't persisted, only live).
- `docker-compose.yaml`, `README.md`, `Docs/V0_5_PLAN.md`
  swept for the container-name rename.

### Upgrade

- Hub: `cd ~/gpuviewr && docker compose pull && docker compose
  up -d --force-recreate`. The old `gpuviewr-agent-local`
  container is removed by compose during recreate.
- LLM badges appear automatically on the next collector tick
  for processes that match a known runtime. Other GPU processes
  render as before (no badge).

## [0.7.2] - 2026-05-18

UX patch around the AMD GPU% gap exposed by v0.7.1 lab testing.

### Added

- **GPU% column fallback for per-process table.** When the driver
  doesn't expose per-PID compute share (AMD with
  cu_occupancy="unknown" from the kernel — observed on .210 with
  ROCm + amdgpu — and NVIDIA when pmon doesn't see the process),
  the cell now renders the **card's global utilization** prefixed
  with `~` in italic dim text, with a tooltip explaining the
  approximation. Previously the column showed a flat `-` and gave
  no indication GPU was being used. The fallback only fires when
  the per-PID value is null AND the card-level utilization is
  known. New i18n keys EN/FR
  (`dashboard.processes_gpu_pct_approx`).

### Internal

- `GpuProcessesTable` accepts a new optional prop
  `gpuUtilFallback?: number | null`. Threaded from `Dashboard.tsx`
  using `active.utilization ?? null` — same value the GPU's
  primary utilization tile shows.
- New `<GpuPctCell>` helper renders the three-state column:
  authoritative number, approximation with tooltip, or `-`.

## [0.7.1] - 2026-05-18

Patch release fixing two things spotted during v0.7.0 lab validation
on the .210 AMD master:

### Fixed

- **`process_name="unknown"` on every AMD GPU process.** Root cause
  was inside the agent's runtime image: `rocm-smi --showpids` shells
  out to `ps` to translate PIDs into process names, but our
  `node:22-trixie-slim` base ships without it. `rocm-smi` prints
  `ps: not found` on stderr and returns the literal string `"unknown"`
  as the `process_name` CSV field — independent of whether
  `/host/proc` is mounted or whether our v0.7.0 `resolveProcessName`
  fallback fires. Adding `procps` to the agent Dockerfile fixes the
  issue at its source. The fallback in `processesRocm.ts` still
  covers the case where `/host/proc` IS mounted but `ps` isn't,
  which is now belt-and-suspenders.
- **`update-version.sh` was bumping nested dependency versions in
  `package-lock.json`** when their `"version"` field happened to
  match the app version being replaced. v0.6.5 → v0.6.9 each
  silently drifted a `node_modules/source-map-support/node_modules/
  source-map` entry from 0.6.5 → 0.6.9 — still satisfying its
  `^0.6.0` constraint by accident. v0.7.0 pushed it to 0.7.0, which
  violates the constraint and broke `npm ci` on every CI job for the
  initial v0.7.0 push. The second `sed` is now range-bounded to the
  `"packages": {` → first `},` window so only the root
  `packages.""` entry is touched. Already fixed on main in commit
  `d785bbc`; folded into the release notes here for completeness.

### Internal

- `agent/Dockerfile`: adds `procps` to the `apt install` line.
  Image size delta: ~+250 KB. Worth it.
- `agent/dist/agent.mjs`: rebuilt at v0.7.1 (no source changes,
  just the version stamp).

### Known limitations on AMD after v0.7.1

- **GPU% column still `-`** on .210 — `rocm-smi --showpids` returns
  `cu_occupancy="unknown"` from the kernel on certain ROCm /
  amdgpu combinations. Driver-side issue, not our bug. NVIDIA's
  `nvidia-smi pmon` SM% is the closer-to-universal equivalent.

### Upgrade

- Hub: `cd ~/gpuviewr && docker compose pull && docker compose up
  -d --force-recreate`. The new agent image (`ghcr.io/erreur32/
  gpuviewr-agent:latest` or `:v0.7.1`) ships with `ps`. AMD users
  will see real process names on the next tick.
- The `/proc:/host/proc:ro` volume mount added in v0.7.0 to the
  master docker-compose.yaml is still recommended (gives CPU% in
  the process table) — refresh your local `docker-compose.yaml`
  from main if you haven't yet.

## [0.7.0] - 2026-05-18

Minor release — first Windows-stable build (real test green on a home
RTX 3090 Ti box), AMD / Intel coverage on Windows via PDH counters,
AMD process-table fixes, and README positioning around AI / LLM
workloads.

### Added

- **AMD / Intel GPUs supported on Windows via PDH counters.** New
  `agent/src/collectors/gpuWindowsPdh.ts` taps the same
  `Win32_PerfFormattedData_GPUPerformanceCounters_{GPUEngine,
  GPUAdapterMemory}` WMI classes Task Manager uses. Language-
  independent (works on French / German / non-en-US Windows out of
  the box, unlike localized typeperf counter paths). One long-running
  `powershell.exe -NoProfile` polls the counters and emits one JSON
  snapshot per tick to stdout — paid the spawn cost once at boot
  instead of every tick. Surfaces utilization (highest engine util
  per adapter, matches Task Manager) and dedicated VRAM. Temp / power
  / freq / PCIe stay null — PDH doesn't expose them; NVIDIA users
  still get the full picture via `nvidia-smi.exe`.
- **`resolveVendor` win32 fallback now routes to PDH.** Previously a
  Windows box without `nvidia-smi.exe` resolved to `vendor=nvidia`
  and exited at boot with "smi not found". With v0.6.9 it instead
  ran with `gpuHandle = null` (host stayed online, emitted no
  samples). v0.7.0 lets it fall through to the PDH collector — same
  numbers Task Manager shows, no driver tool needed.
- **`install.ps1` messaging updated.** No longer says "AMD GPUs on
  Windows are not supported"; instead announces the PDH fallback and
  lists what it covers (util + VRAM) vs what it doesn't (temp /
  power / freq).
- **README positioned around AI / LLM workloads.** New top-of-README
  callout names the actual inference runtimes the dashboard is
  designed to surface — Ollama, llama.cpp, vLLM, ComfyUI, Stable
  Diffusion, KoboldCpp, text-generation-webui, LM Studio — instead
  of leaving the use case abstract.

### Fixed

- **AMD process table no longer shows "unknown" + empty CPU%/GPU%.**
  Three bugs in the same path:
  1. `processesRocm.ts` fell back to the literal string `'unknown'`
     when `rocm-smi --showpids` returned an empty `process_name`
     field (common with non-root callers and older ROCm builds).
     Now falls back to `resolveProcessName(pid, hostProc)` — argv[0]
     basename, then `/proc/<pid>/comm` — same ladder the nvidia
     collector already uses for `[Not Found]` / N/A rows.
  2. `gpu_pct` was hardcoded to `null`. We were already parsing
     `cu_occupancy` (the AMD equivalent of nvidia-smi pmon's SM%:
     share of compute units the process is using) but discarding
     it. Now surfaced as `gpu_pct` so the UI renders a real number.
  3. The master `docker-compose.yaml` agent sidecars (both `agent-
     nvidia` and `agent-amd`) were missing the `/proc:/host/proc:ro`
     mount and `HOST_PROC=/host/proc` env. The CPU sampler couldn't
     read `/proc/<pid>/stat`, so CPU% was permanently null even for
     pids the collector knew about. Added on both sidecars +
     standalone `docker-compose.agent.nvidia.yaml` (the standalone
     AMD compose was already correct).
- **Launcher log redirection from `*>>` to `2>&1 | Out-File`.**
  Shipped late in v0.6.9 as commit 7bc3829 — folding into the
  release notes here for completeness. The `*>>` form triggered
  `NativeCommandError` noise in `agent.log` on every node stderr
  line; merging stderr→stdout before PowerShell sees it as native
  stderr silences the spam.
- **Soft-fail on missing `nvidia-smi.exe` on Windows.** Same commit
  7bc3829 — agent now logs a warning and falls back (to PDH as of
  v0.7.0) instead of `process.exit(1)`, so the WS hello frame
  reaches the hub and the host shows online.

### Internal

- New file: `agent/src/collectors/gpuWindowsPdh.ts` (~5 KB minified
  in the agent bundle, total bundle size 181 KB).
- `agent/src/index.ts` win32+amd fail-fast removed (was a guard from
  v0.6.7 when AMD-on-Windows was deliberately out of scope).

### Upgrade

- Hub: `cd ~/gpuviewr && docker compose pull && docker compose up -d`.
  Pulls the new image with the PDH collector in `agent.mjs`, plus the
  `/proc` mount on the master compose sidecars. **AMD master boxes
  need a full `up -d` (not just `restart`) for the new volume to
  take effect.**
- Linux agents: hub auto-update picks up the new bundle.
- Windows agents (installed via v0.6.7+ `install.ps1`): the
  `launcher.ps1` supervisor swaps in the new bundle on the next
  `agent_update` push.
- AMD-on-Windows / Intel-on-Windows users: re-run the install.ps1
  one-liner from the Add Host modal to validate the PDH path locally.

## [0.6.9] - 2026-05-18

Iteration release driven by the first real Windows agent install
(VPN'd Win10 against the .210 lab hub). Each item below maps to a
bug that surfaced during that test run and got patched on the fly.

### Added

- **Auto-install Node 22+ via `winget` on Windows.** When the
  installer detects Node missing or older than 22, it now runs
  `winget install OpenJS.NodeJS.LTS --silent
  --accept-source-agreements --accept-package-agreements`, refreshes
  `$env:Path` from the Machine + User registry hives so the freshly-
  installed `node.exe` is visible without a logoff, and re-probes.
  Older Win10 SKUs without `winget` still get the previous "go to
  nodejs.org" failure message. Mirrors `install.sh.tpl`'s NodeSource
  auto-install on Linux.
- **`install_mode='windows'` propagated end-to-end.** Agent's
  `detectInstallMode()` returns `'windows'` on `process.platform ===
  'win32'`. Hub's `forceAgentUpdate` + `maybePushAutoUpdate` now
  accept `'windows'` alongside `'systemd'` for the auto-update gate
  (semantics match: `launcher.ps1`'s while-loop swaps
  `agent.mjs.pending` into place on the next iteration, ~5 s
  downtime, equivalent to systemd's `RestartSec=5`). New "Windows"
  pill in `InstallTypeCell` on the Hosts settings page with i18n
  EN/FR.
- **Central SVG icon registry** (`src/components/ui/icons/IconRegistry.tsx`).
  Single typed source of truth — addressable as `<Icon
  name="platform.windows" size={14} />`. Six initial entries:
  `vendor.nvidia`, `vendor.amd`, `platform.windows`,
  `platform.linux`, `platform.docker`, `platform.systemd`. Adding
  a new icon = one record entry. Windows icon uses the modern
  Fluent four-square logo in `#0078D4` (Microsoft's current brand
  color, crisper at 14-16 px than the older asymmetric Win10
  variant).
- **Scheduled-task supervisor captures node output.** `launcher.ps1`
  now redirects every stream from `node agent.mjs` to
  `C:\ProgramData\GpuViewR-Agent\agent.log` via `*>>` append. The
  hidden SYSTEM task previously discarded all output to a void; a
  crashing agent was invisible. Tailable with `Get-Content '...'
  -Wait`. The final install message surfaces the log path as the
  first diagnostic command.
- **`scripts/check-docker-build.js` asserts install-distribution
  files inside the built image.** Runs `docker run --rm <tag> sh -c
  'test -f ...'` for the four files the install endpoints serve at
  runtime (`install.sh.tpl`, `install.ps1.tpl`, `agent.mjs`,
  `install-agent.sh`). Codifies the lesson from the v0.6.7 → v0.6.8
  incident where `install.ps1.tpl` was on disk but missing from the
  image, so the route 503d for every Windows user.

### Fixed

- **`install.ps1` ACL step failed on VPN'd / domain-joined / localized
  Windows hosts.** The script was calling `New-Object
  FileSystemAccessRule('NT AUTHORITY\SYSTEM', ...)` which requires
  LSA to translate the name into a SID — that lookup fails on some
  installs with "Impossible de traduire certaines ou toutes les
  références d'identité." Switched to the well-known SID constants
  (`S-1-5-18` = LocalSystem, `S-1-5-32-544` = BuiltinAdministrators).
  SIDs are language-independent and need no name resolution. The ACL
  step is also now wrapped in `try/catch` — on a future surprise it
  degrades to a warning ("falling back to default ProgramData ACL")
  instead of aborting the install. The agent token is still not
  world-readable in that fallback because ProgramData's default ACL
  already excludes non-admin Users from read access.

### Internal

- **`refactor(modal): replace nested ternaries with mode-keyed
  lookups`.** SonarCloud flagged three nested-ternary code smells
  introduced by the v0.6.7 modal additions; fixed by building a
  `Record<InstallMode, string>` map up front and indexing into it.
  No behavior change.
- **Dependabot dependency bumps** merged: `react-router-dom 7.15.1`
  + `tsx 4.22.1` (npm minor patch group), and
  `github/codeql-action 3.35.5` (CI workflows).

## [0.6.8] - 2026-05-18

### Fixed

- **Windows installer 503 inside the Docker image.** v0.6.7 shipped
  the `install.ps1.tpl` template in the repo and added the
  `GET /install.ps1` route, but the hub `Dockerfile` only `COPY`d
  `install.sh.tpl`. The PowerShell endpoint returned a 503 with
  `# install.ps1 template not found in this build` to every user
  who clicked the new **Windows** pill in the Add Host modal.
  Added the missing `COPY` line. No code change — purely a build
  recipe omission caught the moment the first real user pasted
  the one-liner.

## [0.6.7] - 2026-05-18

### Added

- **Windows agent support — NVIDIA, GPU stats only.** A new
  `install.ps1` is served by the hub at `GET /install.ps1` and a
  third **Windows** tab in the Add Host modal generates a copy-paste
  PowerShell one-liner. The installer:
  - validates Administrator + Node 22+ + `nvidia-smi.exe`,
  - drops the cross-platform `agent.mjs` bundle in
    `C:\ProgramData\GpuViewR-Agent\`,
  - writes an env file with stripped ACL (SYSTEM + Administrators
    only — the agent token can't be read by interactive users),
  - registers a SYSTEM-level **Scheduled Task** with `AtStartup`
    trigger (15 s delay so the network is up before the WS dials)
    and `RestartCount 9999`,
  - spawns `launcher.ps1`, a tiny supervisor while-loop that swaps
    in `agent.mjs.pending` (auto-update path) before each `node`
    invocation and respawns after a 5 s backoff.
  AMD on Windows is not supported (no `rocm-smi` equivalent in the
  Windows driver stack). Process list, CPU/RAM telemetry, and
  `nvidia-smi pmon` are skipped — the WDDM driver model doesn't
  expose `pmon`, and `/proc` only exists on Linux.
- **Windows-safe auto-update path.** `agent_update` frames detect
  `process.platform === 'win32'` and stage the new bundle as
  `agent.mjs.pending` instead of an in-place `renameSync` onto a
  possibly-locked file. The launcher's supervisor loop picks it up
  on the next iteration. Without this branch a clean `exit(0)` from
  the agent on Windows would never have re-triggered a Scheduled
  Task `AtStartup` trigger — the agent would have stayed dead until
  reboot.

### Fixed

- **`install.sh` back-fills missing required secrets on upgrade.**
  A user upgrading from v0.4.x kept their pre-v0.5 `.env` (no
  `LOCAL_AGENT_BOOTSTRAP`) and the local sidecar agent crash-looped
  with `[FATAL] Missing required env var: AGENT_TOKEN`. The
  installer's "preserve existing .env" branch now back-fills any
  missing `JWT_SECRET` / `LOCAL_AGENT_BOOTSTRAP` lines (random,
  date-stamped, appended) without touching pre-existing
  customisations. Idempotent — running twice doesn't duplicate.

## [0.6.6] - 2026-05-17

### Fixed

- **SonarCloud duplication on new code.** The v0.6.5 hosts-table
  migration repeated the same idempotent ADD-COLUMN pattern three
  times in `server/database/connection.ts`, which tripped the
  Quality Gate's "Duplicated Lines on New Code" threshold (8.3% >
  3%). Refactored to a small `[name, type][]` table + loop — same
  runtime behavior, ~12 fewer lines, no duplication. No DB change.

## [0.6.5] - 2026-05-17

### Added

- **Periodic auto-update scheduler for systemd agents.** Until now
  the hub's auto-update only fired at WS hello, so an agent that
  stayed connected for weeks never saw a new release unless an
  admin clicked "Update now". A new background scheduler ticks
  every hour (configurable via `AUTO_UPDATE_CHECK_INTERVAL_MS`),
  iterates `auto_update=1 + install_mode=systemd + connected`
  hosts, and calls the existing `maybePushAutoUpdate` so the four
  gate checks (opt-in, install_mode, isOlder, cooldown) stay in
  one place. First tick is delayed 30 s after boot to let fresh
  agents complete their welcome handshake first.
- **Persistent auto-update state.** Three new columns on `hosts`:
  `last_update_check_at`, `last_update_pushed_at`,
  `last_update_pushed_version`. Survive hub restarts and bootstrap
  the in-memory cooldown map at `setupAgentIngestWS` time — a hub
  bounce no longer re-pushes the bundle to every agent that
  immediately reconnects.
- **Auto-update tooltip in Settings → Hosts.** The auto_update
  toggle now shows "Last check: Xm ago" and "Last push: → vN
  (Xm ago)" on hover, with full i18n (FR + EN).
- **Configurable cooldown.** `AUTO_UPDATE_COOLDOWN_MS` env var,
  default 5 min (unchanged). Lower it to test the scheduler
  end-to-end without waiting 5 minutes between iterations.

### Changed

- **Hub install.sh now logs the resolved INSTALL_DIR** at startup
  with the reason it picked that path (env var / `$PWD` / default
  fallback). Catches `cd /opt && curl|bash` → "dumped loose in
  /opt" before the user notices.
- **README install section rewritten.** New "Where it installs"
  subsection with the 3-rule resolution + concrete examples.
  Agent install section clarified: `--url` accepts http(s) and
  ws(s) interchangeably (since v0.6.4), and token format gotchas
  spelled out.

### Upgrade

- Hub: `docker compose pull && docker compose up -d`. The DB
  migration adds 3 columns idempotently — no manual step.
- Agents: no change required.

## [0.6.4] - 2026-05-17

### Fixed

- **Install script: `--url ws://` produced "Empty reply from server".**
  `curl` can't speak `ws://`, so the bundle download line was failing
  silently when users passed the WS URL directly. The script now
  derives the HTTP form (`ws→http`, `wss→https`) for the download
  while keeping the WS form for the agent's env file. Both schemes
  are now interchangeable as `--url` input.
- **Install script: no-dot token installed silently with garbage
  `HOST_ID`.** A token without a `.` separator (e.g. one copied from
  the v0.6.3 `rotate-token` response) used to pass the existing
  `HOST_ID != SECRET` check by accident, then the agent would
  register with a wrong `host_id` and stay offline forever. Now the
  script bails up-front with a clear "missing '.' — copy the line
  from the Add Host modal" message.
- **`POST /hosts/:id/rotate-token` returned an install-incompatible
  token.** The response previously contained only the random secret
  (`gpvr_<base64url>`), with no `host_id` prefix, while the install
  script expects `<host_id>.<secret>` (the format the Add Host modal
  produces at enrollment). Rotated tokens now ship the full
  `<host_id>.<secret>` bundle, ready to paste into the install
  command. The bcrypt hash is still computed on the raw secret half
  — only the response payload changed.
- **`scripts/update-version.sh` didn't bump `agent/package.json`.**
  The agent build reads its own `package.json` to inject
  `__AGENT_VERSION__`, so without this fix every release would ship
  an agent bundle stamped with the previous version, making the hub
  re-push the "newer" bundle on every reconnect until the cooldown
  fired. The script now bumps `agent/package.json` alongside the
  root `package.json` (and reports it in the summary).

### Upgrade

- Hub: `docker compose pull && docker compose up -d`.
- Agents: no agent-side change in this release; agents stay on
  v0.6.3 (or later) and reconnect normally. Future enrollments
  benefit from the install-script fixes automatically.

## [0.6.3] - 2026-05-17

### Fixed

- **Agent EROFS spam on systemd installs.** With `ProtectSystem=strict`
  and an empty `ReadWritePaths=`, `/opt/gpuviewr-agent` was read-only,
  so every hub-pushed `agent_update` raised `filesystem swap failed:
  EROFS` and contributed to a close 1008 / reconnect storm. The agent
  now pre-checks write access on the install dir and emits a single
  WARN per session instead of one ERROR per update push.
- **NVIDIA process collector ran at `TICK_MS` instead of
  `PROCESSES_TICK_MS`.** The AMD branch already used the throttled
  value; the NVIDIA branch passed `cfg.tickMs` (1 s) instead of
  `cfg.processesTickMs` (default 2 s). Halves nvidia-smi compute-apps
  + pmon spawn rate with `FEATURES=processes`.
- **Rate-limit storm during replay.** A reconnect with N buffered
  frames drained at `REPLAY_CHUNK` fps in parallel with live samples;
  combined they tripped the hub's `RATE_LIMIT_PER_SEC=100` and looped
  close 1008 → reconnect → replay → close. A new per-connection
  `replaying` flag queues live samples behind the drain so the wire
  carries one stream at a time.
- **Reconnect backoff reset too eager.** The 1 s backoff reset fired
  on `open`, before the connection had held — a hub that accepted the
  WS then closed 1008 immediately would loop at 1 s. Reset now waits
  30 s of stable connection.
- **False WARN at boot on docker-aliased hubs.** `ws://` validation
  flagged any non-IPv4-private hostname (e.g. compose alias `hub`)
  as "non-private". The warn now fires only for IP literals that are
  actually public.

### Changed

- **Systemd unit `Restart=on-failure` → `Restart=always`.** The agent
  self-replaces its binary on hub-pushed updates and exits 0; the
  previous policy treated that as success and left the service dead.
- **Systemd unit `ReadWritePaths=/opt/gpuviewr-agent` added.** Carves
  the install dir out of `ProtectSystem=strict` so the atomic
  `writeFileSync` + `renameSync` lands. Combined with the fixes
  above, auto-update is now functional end-to-end on systemd.

### Upgrade

- Hub: `docker compose pull && docker compose up -d`.
- Agents on Docker: `docker compose pull && docker compose up -d`.
- Agents on systemd: v0.6.2 cannot auto-update itself (the EROFS is
  the bug we're fixing). Reinstall via the install script, or `scp`
  the new `agent.mjs` into `/opt/gpuviewr-agent/` and
  `systemctl restart gpuviewr-agent`. From v0.6.3 onward, the
  "Update now" button works on systemd too.

## [0.6.2] - 2026-05-16

### Added

- **"Update now" button per host.** Settings → Hosts gains a
  DownloadCloud icon button left of the auto-update toggle. Clicking
  it asks the hub to push the current bundle over the live WS to
  that agent immediately, bypassing the auto_update opt-in, the
  5-minute cooldown, and the version-compare gate. Useful when an
  agent has been stably connected for days and would otherwise
  never see a new hub version (auto-update only fires at WS
  reconnect, not on a periodic timer).
- **Live agent WS registry** in `agentIngestWS`. Keyed by canonical
  host_id, populated at connection time and cleared on close. Lets
  the new `POST /api/hosts/:id/force-update` route push to a
  specific agent without owning the connection's closure.
- **`forceUpdate(id)` action** in the hosts client store, returning
  the version + bundle size pushed.

### Constraints

- Force-update is **systemd-only**. Docker bundles are baked into a
  read-only image layer and can't be replaced from inside the
  container — the button is disabled with a tooltip pointing users
  at `docker compose pull && up -d` instead.
- The button is also disabled when the agent isn't currently
  connected (no WS = nothing to push). Tooltip explains.

### Reverted

- The FleetChart "filter hosts with no live samples" change from
  the pre-release branch is rolled back — it hid legitimate hosts
  during the brief WS-warmup window after page load. The
  pre-existing "index-0 host's solid line invisible when local hub
  has no sidecar" UX issue is being tracked separately.

## [0.6.1] - 2026-05-16

### Fixed

- **Agent now reports its real version.** `AGENT_VERSION` was a
  hardcoded `'0.5.3'` literal in `agent/src/transport.ts`, so the
  v0.6.0 bundle still announced itself as 0.5.3 in the hello frame
  and in any log line it touched. Esbuild now injects
  `__AGENT_VERSION__` from `agent/package.json` at bundle time —
  same trick Vite uses for the frontend `__APP_VERSION__`. The typeof
  guard keeps `tsx`/dev runs alive with a `'0.0.0-dev'` fallback.
- **Agent Docker image now builds.** The version-injection refactor
  moved the esbuild call into `agent/scripts/build.mjs`, but
  `agent/Dockerfile` didn't COPY that directory into the builder
  stage — `npm run build` failed with `MODULE_NOT_FOUND` and the
  v0.6.0 GHCR push was rejected.

### Added

- **Boot banner with version + install mode.** Agents now log a
  prominent first line that grep-friendly shows up under
  `systemctl status` and `docker logs`:
  `gpuviewr-agent v0.6.1 (docker) starting on node v22.x.x`. Saves
  the "which version is actually running" guesswork after a binary
  rollout.
- **"Type" column in the Hosts settings table.** Shows Docker /
  Binaire / Hub / — (with icons + tooltips) based on the `install_mode`
  the agent reports in its hello frame. Pre-v0.5.3 agents render as
  a muted `—` with a tooltip explaining the upgrade.

## [0.6.0] - 2026-05-16

### Added

- **Sysfs-direct AMD GPU backend.** The agent now reads GPU samples
  (temperature, utilization, VRAM, clock, power) straight from
  `/sys/class/drm/card*/device/` instead of spawning `rocm-smi` every
  tick. `rocm-smi` is a Python script that loads `librocm_smi64.so`
  via ctypes per call (~80-130 ms wall, ~50-80 ms CPU at 100 %); the
  sysfs path takes < 1 ms. On a 1 Hz tick this drops the AMD agent's
  CPU baseline from ~0.2-0.4 core to near-zero on idle hosts.
- **`GPU_BACKEND` env var (AMD only).** Defaults to `auto`: probe
  sysfs first, fall back to `rocm-smi` if `/sys/class/drm` exposes no
  amdgpu card. `sysfs` forces the cheap path; `rocm-smi` keeps the
  legacy collector. NVIDIA path is unchanged.
- **`PROCESSES_TICK_MS` env var (AMD only).** Decouples the
  `rocm-smi --showpids` cadence from `TICK_MS`. Defaults to
  `max(2000ms, TICK_MS × 2)` — halves the legacy 1 Hz CPU cost while
  keeping the process list visibly fresh.

### Changed

- The AMD compose stub now documents the new env vars and notes that
  ROCm at `/opt/rocm` is only required when `FEATURES` includes
  `processes`. The sysfs backend works with just the amdgpu kernel
  driver, no userland ROCm needed.
- `createRocmGpuCollector` gained the same `inflight` guard that
  `processesRocm` already had — prevents tick pile-up if a slow
  `rocm-smi` call momentarily exceeds `TICK_MS`.

## [0.5.3] - 2026-05-16

### Added

- **Agent declares its install mode.** Each agent now detects at boot
  whether it runs in Docker (`/.dockerenv`, `/proc/self/cgroup`) or
  under systemd (`INVOCATION_ID` / `JOURNAL_STREAM`) and reports it
  in the hello frame. The hub stores it per host (new
  `hosts.install_mode` column, idempotent `ALTER TABLE` migration).
  The Hosts tab's "Update" pill now shows ONLY the recipe that
  matches the remote — bare-metal `curl + systemctl restart` or
  `docker compose pull && up -d` — instead of both. Running the
  wrong recipe on a Docker host used to create a second agent in
  parallel; the per-host selection makes that impossible. Pre-v0.5.3
  agents that don't report their mode get both recipes in the
  tooltip with a warning, and the bare-metal one copied by default.
- **Opt-in WebSocket auto-update for systemd agents.** A new
  per-host toggle (circular-arrows icon next to Rotate/Delete) flips
  `hosts.auto_update`. When ON for a bare-metal host whose agent
  version trails the hub, the hub pushes the latest `agent.mjs` as
  base64 + SHA256 over the existing WS at hello time. The agent
  verifies the checksum, writes `/opt/gpuviewr-agent/agent.mjs.new`,
  fsyncs, renames atomically, and exits — systemd's `Restart=`
  picks up the new binary on the next launch. Cooldown 5 min per
  host stops a crash-loop on the remote from saturating the WS.
  Off by default because flipping it gives the hub binary-execute
  authority on the remote machine; admins should consciously trust
  this hub first. Docker hosts are excluded (read-only image
  layer — can't self-replace the bundled binary) and keep the
  manual `docker compose pull` recipe.

### Validation

- typecheck clean (5 pre-existing errors not touched)
- hub + agent build green (agent bundle 163.5 KB)
- 19/22 server tests pass (3 pre-existing failures on the v0.4 →
  v0.5 migration suite, not touched by this release)
- No new SonarCloud-flagged patterns

### Upgrade

- Hub: `docker compose pull && docker compose up -d` on the master.
- Bare-metal agents: re-run `install.sh` from the hub (idempotent),
  OR enable auto-update once and let the next push happen
  automatically.
- Docker agents: `docker compose pull && docker compose up -d`
  in the agent's compose directory.

## [0.5.2] - 2026-05-16

### Fixed

- **Stale JWT after a hub DB reset froze the UI silently.** When the
  user ran `rm -rf data && docker compose up -d` the new
  `JWT_SECRET` made the browser's stored token invalid. API calls
  returned 401 but the frontend never reacted — the dashboard hung
  on "no GPU detected" with no hint that re-login was needed.
  `src/lib/api.ts` now intercepts 401 on any non-`/auth/*` path,
  clears `localStorage`, and `location.assign("/login?expired=1")`.
  LoginPage reads `?expired=1` and shows an amber "Your session has
  expired" banner (i18n: `auth.session_expired`).
- **`install.sh` leaked `WARN[0000] variable not set`** on
  re-installs against an already-running stack. Generating `.env`
  BEFORE downloading `docker-compose.yaml`, then `set -a; . ./.env;
  set +a` exports the vars into the script's shell so subsequent
  `docker compose` invocations inherit them — no more env-var
  warnings during reconcile.
- **Hidden `--progress quiet` removed** — users now see native
  Compose pull progress (image layers downloading in real time)
  during install. The previous quiet flag was a workaround for the
  WARN noise the fix above kills properly.

### Added

- **TLS toggle in the "Add Host" modal.** A checkbox "Hub uses TLS
  (wss://)" lets users override the auto-detection. Default is
  inferred from the hub URL host: IP literals / `localhost` →
  `ws://`, FQDN → `wss://`. Catches the case where a browser
  auto-upgrades `http://` to `https://` on a plain-HTTP LAN hub
  (HSTS), which previously generated bogus `wss://...:443/agent`
  URLs and made the agent fail with `ECONNREFUSED`.
- **"Re-run to update" hint** under the install command in the
  Add Host modal. Tells users that running the exact same
  `install.sh` / `install-agent.sh` command upgrades the agent —
  no separate update script needed.

## [0.5.1] - 2026-05-16

### Fixed

- **Bare-metal agent crashed at boot with `ERR_MODULE_NOT_FOUND
  'ws'`.** The bundle was built with `--external:ws`, expecting the
  install path to set up a `node_modules` alongside, but `install.sh`
  only drops `agent.mjs` on disk. Now `ws` is bundled inline (38 KB →
  161 KB bundle, acceptable). The optional native deps
  (`bufferutil` / `utf-8-validate`) stay external — `ws` falls back
  gracefully.
- **Bare-metal `install.sh` died on AMD hosts** with "nvidia-smi not
  found". Pre-flight now accepts either `nvidia-smi` or `rocm-smi`
  (PATH or `/opt/rocm/bin/rocm-smi`); only exits when neither is
  found. Matches the v0.5 vendor-neutral story.

### Added

- **`/install-agent.sh`** — Docker-flavoured remote agent installer,
  symmetric to `install.sh` (bare-metal). Auto-detects vendor on the
  target, pulls the matching `docker-compose.agent.{nvidia,amd}.yaml`
  from main, generates `.env` from `--hub` + `--token`, runs
  `docker compose up -d`. The hub serves it at `/install-agent.sh`.
  EnrollHostModal's "Docker" mode now shows the new curl one-liner
  (works on both vendors instead of NVIDIA-only `docker run --gpus`).
- **install.sh respects `$PWD`** when the user has `cd`'d into a
  non-default dir (anything other than `/`, `$HOME`, `/root`, or
  `/tmp`). No more need for `GPUVIEWR_INSTALL_DIR=/path` env override
  when the user is already where they want the install. Same logic
  in `install-agent.sh`.

### Changed

- **install.sh silenced `WARN[0000]` noise** during install. Compose
  v2 writes some warnings to `/dev/tty` directly (bypasses normal
  stdout/stderr redirects), and output buffering on a `curl | bash`
  pipe occasionally surfaced them before `.env` lived on disk.
  Passing `--progress quiet` to both `compose pull` and `compose up
  -d` kills the chatter; the final "Container Healthy" summary
  still prints.

## [0.5.0] - 2026-05-16

### Architecture

**The hub is now vendor-neutral**. All GPU sample collection — local
or remote — goes through the agent WS ingest path. The previous
hub-local `gpuCollector` / `rocmGpuCollector` / `processCollector` /
`rocmProcessCollector` / `activeGpuCollector` modules are deleted
(–965 LOC net). The hub image no longer bundles `python3` or
`libdrm-amdgpu1` (~80 MB smaller); local GPU monitoring is provided
by a sidecar agent in the same compose stack.

See [`Docs/V0_5_PLAN.md`](Docs/V0_5_PLAN.md) for the design rationale
(D1-D8) + every jalon's intent.

### Added

- **`install.sh`** at the repo root — one-liner `curl … | bash` that
  auto-detects vendor (NVIDIA / AMD / none), pulls
  `docker-compose.yaml`, generates `.env` with random secrets +
  proper `COMPOSE_PROFILES`, runs `docker compose up -d`.
  Idempotent. Customisable via `GPUVIEWR_INSTALL_DIR` and
  `GPUVIEWR_BRANCH` envs.
- **Single `docker-compose.yaml`** with Docker Compose profiles
  (`nvidia`, `amd`). Hub is always started; only the right sidecar
  service activates based on `COMPOSE_PROFILES` in `.env`. Switch
  vendor by editing one line and re-running `docker compose up -d`.
- **Bootstrap token auth** for the local sidecar. The hub config
  carries `LOCAL_AGENT_BOOTSTRAP`; the sidecar agent presents the
  same token + `HOST_ID=local` and gets auto-enrolled on first
  handshake. No more clicking through Settings → Hosts for the
  local box. Constant-time compare to avoid leaking the secret
  through timing.
- **Agent multi-hub mode** — one agent can push to N hubs in
  parallel:
  ```env
  HUB_URLS=wss://hub1/agent,wss://hub2/agent
  HOST_IDS=<id-on-hub1>,<id-on-hub2>
  AGENT_TOKENS=<token-on-hub1>,<token-on-hub2>
  ```
  Each hub gets its own WS connection, reconnect backoff state,
  ping timer, and offline-replay buffer — a slow hub never gates
  samples to a fast one. Legacy singular `HUB_URL`/`HOST_ID`/
  `AGENT_TOKEN` continues to work (array-of-1 internally). Three
  consecutive auth failures on a single hub give up on that hub
  only; other hubs keep going.
- **`server/services/_processTypes.ts`** — shared `GpuProcess`
  interface, lifted out of the deleted `processCollector`.
- **`server/services/retentionJob.ts`** — extracted
  `startRetentionJob`, independent of any collector lifecycle.

### Changed (breaking)

- **`server/services/gpuCollector.ts`, `rocmGpuCollector.ts`,
  `activeGpuCollector.ts`, `processCollector.ts`,
  `rocmProcessCollector.ts`, `_gpuCollectorBase.ts`,
  `_procUtil.ts`, `nvidiaSmi.ts`, `rocmSmi.ts`** — all removed.
  Anyone importing these from their own code needs to read from
  `metricsBus.getLatestByHost()` instead.
- **`config.gpuVendor` / `config.rocmSmiPath` / `parseVendor`** —
  removed from the hub config. Those vars only live on the agent
  side now.
- **Route behaviour**: `GET /api/gpu/current?host=local` no longer
  has a special branch — it reads `metricsBus.getLatestByHost('local')`
  exactly like remote hosts. Same for `/api/processes`,
  `/api/health.gpuCount`, `/api/system.gpus`.
- **`Dockerfile`** dropped `python3` + `libdrm-amdgpu1`. Hub image
  ~250 MB → ~170 MB.
- **`docker-entrypoint.sh`** simplified: no more vendor probe
  inside the hub container; the sidecar owns that.
- **Compose files renamed** :
  ```
  compose.yaml                    → docker-compose.yaml
  compose.agent.nvidia.yaml       → docker-compose.agent.nvidia.yaml
  compose.agent.amd.yaml          → docker-compose.agent.amd.yaml
  ```
  Old `compose.*` paths no longer exist on `main`. Pinned tags
  retain their `.yml` snapshot history.
- **`README.md` rewrite** — 586 → 210 lines. Single install path
  (curl install.sh), no more parallel NVIDIA / AMD / aggregator
  sections. Manual fallback in collapsed `<details>`.

### Migrated automatically

- `hosts` row with `id='local'` and legacy `kind='local'` is bumped
  to `kind='agent'` on first v0.5 boot via `seedLocalIfMissing()`.
  The row stays under the same `id='local'` so every foreign key
  in `gpu_metrics` / `gpu_devices` / `alert_events` keeps pointing
  at the same record. History preserved.
- First sidecar handshake calls `upsertLocalSidecarHost` (in
  `agentIngestWS`) which is idempotent — re-runs on every reconnect.

### Removed

- `Docs/REMOVE_UPDATE_SH.md` — stale rationale doc.
- The `.yml` compose symlinks that briefly existed in v0.4.2 — pure
  cosmetic clutter.

### Migration path

```bash
# On Jarvis / deb13 / any v0.4.x install:
cd ~/gpuviewr
docker compose pull
docker compose up -d
# Migration runs automatically. First user must re-login (JWT
# secret may have rotated if you regenerated .env).
```

If anything goes wrong, the clean slate is one command:

```bash
docker compose down -v   # drops the DB
rm -rf ./data
docker compose up -d
```

## [0.4.2] - 2026-05-16

### Added
- **`docker-compose.nvidia.yaml`** at the repo root. Mirrors the AMD
  recipe — NVIDIA Container Toolkit passthrough enabled out of the
  box. Three compose variants now sit side by side: `nvidia` (NVIDIA
  toolkit), `amd` (`/opt/rocm` + `/dev/kfd` + `/dev/dri`), and the
  vendor-neutral `docker-compose.yaml` (no GPU, hub as aggregator
  only). Quick start lists all three as parallel curl recipes.
- **`HUB_HOSTNAME` env override** for the hub's displayed hostname.
  Wins over the bind-mount auto-detection — useful when
  `/etc/hostname` isn't bind-mounted or returns the container id on
  a particular kernel.
- **Hub `Dockerfile` bakes the agent bundle** (`agent/dist/agent.mjs`
  + `agent/install.sh.tpl`). `/install.sh` + `/agent.mjs` no longer
  503 on first boot — the curl-install path for enrolling remote
  agents works out of the box.
- **Dashboard `HostChip`** showing the resolved hostname + a "Hub"
  pill on `LOCAL_HOST_ID`. Visible on mono-host installs too, where
  the `HostSelector` dropdown self-hides. Same chip on the "All
  GPUs" view.
- **`Hub` badge on the System page** Host card title — matches the
  badge in Settings → Hosts so the visual language stays consistent.

### Changed
- **Compose files renamed `.yml` → `.yaml`.** YAML.org spec
  preference; Docker Compose v2 auto-discovers `.yaml` first. Five
  files: `docker-compose.{yaml,nvidia.yaml,amd.yaml,agent.yaml,
  agent.amd.yaml}`. No `.yml` symlinks kept — clean break.
- **Hostname resolution inside containers.** `os.hostname()` returns
  the container id on Docker. New `server/utils/hostHostname.ts`
  tries in order: `HUB_HOSTNAME` env, `/host/etc/hostname` bind-mount,
  `/host/proc/sys/kernel/hostname`, `os.hostname()` as last resort.
  All three compose variants now bind-mount `/etc/hostname` read-only.
- **Label backfill in `seedLocalIfMissing`** also recognises
  previously-auto-set values: legacy `'local'`, `label === hostname`
  (Docker auto-set), or anything matching the 12-hex container-id
  shape. User-customised labels still preserved.
- **`docker-entrypoint.sh` probe is vendor-aware.** Reads
  `GPU_VENDOR` and checks the corresponding binary (nvidia-smi,
  `/opt/rocm/bin/rocm-smi`, or both for `auto`). Replaces the
  hardcoded "nvidia-smi not found" warning that triggered on every
  AMD container start.
- **System page "GPU" subtitle**, `no_gpu` placeholder,
  `hosts.section_help`, `hosts.hub_badge_help` and the boot banner
  are now vendor-aware (mention both `nvidia-smi` and `rocm-smi`
  where relevant).

### Fixed
- **Hub-side rate-limit warning** logged once per offending frame
  during a disconnect close (80+ lines per agent reconnect storm).
  Now logged exactly once per session with the actual frame rate
  in the message.
- **Agent-side `flushBuffer()` reconnect storm.** After an outage of
  more than ~100 s the offline-replay queue dump exceeded the hub's
  `RATE_LIMIT_PER_SEC=100` ceiling in a single tick, got the agent
  kicked, reconnected, kicked again. Chunked drain (50 frames per
  600 ms) stays under the ceiling and yields to live tick frames
  between batches.
- **`agent/Dockerfile` parser path** still referenced the pre-J1
  `_nvidiaParsers.ts` / `_rocmParsers.ts` filenames, breaking the
  GHCR agent build on every push since the J1 rename. COPY now grabs
  `server/services/parsers/` wholesale.

## [0.4.1] - 2026-05-16

### Added
- **`server/utils/hostHostname.ts`** reads the real host hostname from
  `/host/proc/sys/kernel/hostname` (bind-mount) when the hub runs in a
  container. Replaces `os.hostname()` at three call sites — Hosts
  table label, System page chip, and the local-row seed.
- **`Hub` badge on the System page** Host card title (matches the
  badge in Settings → Hosts).

### Changed
- `docker-entrypoint.sh` probe is now vendor-aware via `GPU_VENDOR`
  — no more "nvidia-smi not found" warning on AMD installs.
- Hub `Dockerfile` bakes `agent/dist/agent.mjs` into the runtime
  image so `/install.sh` + `/agent.mjs` work on first boot.
- Boot banner subtitle: "Real-time NVIDIA / AMD GPU Dashboard".
- `no_gpu` UI placeholder, `system.zone_gpu_sub`,
  `hosts.section_help` and `hosts.hub_badge_help` mention both
  `nvidia-smi` and `rocm-smi`.

## [0.4.0] - 2026-05-16

### Added
- **Single-host AMD install — no agent required.** The hub itself now
  speaks `rocm-smi` on the local machine, so an AMD-only box (Strix
  Halo, RDNA3, discrete Radeon) can run GpuViewR via a single
  `docker compose -f docker-compose.amd.yml up -d` — no separate
  agent container, no enrollment dance. Selection is automatic:
  `GPU_VENDOR=auto` (default) probes `nvidia-smi` first and falls
  back to `rocm-smi`; `nvidia` / `amd` force the corresponding
  collector. New `ROCM_SMI_PATH` env (default `/opt/rocm/bin/rocm-smi`).
  - `server/services/rocmGpuCollector.ts`: hub-side ROCm sample
    collector with the same lifecycle / DB persistence /
    `metricsBus` broadcast / `hosts.last_seen` heartbeat as the
    nvidia collector. Includes the "empty stdout, exit 0" trap
    so a misconfigured `LD_LIBRARY_PATH` surfaces as one warn line
    instead of a silent no-data symptom.
  - `server/services/rocmProcessCollector.ts`: hub-side
    `/api/processes` for local AMD via `rocm-smi --showpids
    --showbus --json`. Same `Snapshot` shape as the NVIDIA path,
    so the frontend gets the same `GpuProcess[]` it expects.
  - `server/services/activeGpuCollector.ts`: vendor resolution
    module. Owns both the sample and process collector picks;
    consumers (`/api/gpu`, `/api/processes`, `/api/health`,
    `/api/system`, `gpuStreamWS`) route through getters instead
    of importing the singletons directly.
  - `Dockerfile` now bundles `python3` + `libdrm-amdgpu1` for
    rocm-smi (a Python script under `/opt/rocm/libexec/`). One
    image, both vendors — NVIDIA users pay ~30 MB extra for the
    interpreter but never reach the code path.
  - `docker-compose.amd.yml` at the repo root for the single-host
    AMD recipe (`/dev/kfd` + `/dev/dri`, `/opt/rocm:ro`
    bind-mount, `LD_LIBRARY_PATH`, `GPU_VENDOR=amd`).
- **Unified-chart mode on the Hosts page.** Third toggle alongside
  *Per host* and *All hosts total*: a single uPlot with util +
  temp + power overlaid, util/temp on the percent axis and power
  on its own watts axis — same layout and colours as the
  Dashboard's `LiveChart` so the visual language matches across
  pages. Aggregates across the visible fleet (avg utilization,
  max temperature, sum power).
- **Vendor logo on host cards.** Replaces the neutral `Server`
  icon with the inferred NVIDIA (#77b900) / AMD (#f63737) badge,
  derived from a case-insensitive substring scan over GPU product
  names. Falls back to `Server` for Intel / empty / unknown.

### Changed
- **"Fleet" page label is now "Hosts" / "Hôtes".** Clearer for the
  solo-sysadmin user; industry terminology (AWS Fleet, FleetDM)
  is preserved via an info-icon tooltip on the page title and a
  note in the Multi-host README section. URLs (`/fleet`),
  component names, and the i18n namespace are intentionally
  unchanged for bookmark compatibility.
- **Vendor parsers moved to `server/services/parsers/`.** The
  agent already reached across the directory tree to import them;
  the underscore prefix and flat layout were the only thing that
  made them feel "internal". `nvidia.ts` and `rocm.ts` now live
  in their own subdir, signalling explicitly that they're the
  shared parse layer between hub and agent. No behaviour change.
- **Hub Dockerfile bumped from `node:22-bookworm-slim` to
  `node:22-trixie-slim`** (glibc 2.41). Same reasoning as the
  agent in v0.3.1: modern ROCm builds need `GLIBC_2.38` /
  `GLIBCXX_3.4.32`, and bookworm's 2.36 caused the bind-mounted
  `librocm_smi64.so.1` to fail to load. NVIDIA installs are
  unaffected.

## [0.3.1] - 2026-05-16

### Added
- **AMD / ROCm support in the remote agent (experimental).** Agents
  now run on AMD hosts (RDNA3, Strix Halo APUs, discrete Radeon)
  via `rocm-smi`. The same image serves both vendors: `GPU_VENDOR`
  (`auto` / `nvidia` / `amd`) selects the right collector at boot,
  with `auto` probing both `nvidia-smi` and `rocm-smi`. Parity with
  the NVIDIA agent for temperature, utilization, power, graphics
  clock, VRAM, and GPU processes (pid / name / VRAM / CPU%). The
  fields ROCm doesn't expose (memory clock on APUs, fan, PCIe
  gen/width/RX-TX, per-process GPU%) come back `null` — the schema
  already permits that.
  - `_rocmParsers.ts`: parses `rocm-smi --json` info dumps + the
    `--showpids` CSV-in-JSON quirk; device-ID lookup with `gfx<n>`
    fallback; synthesizes a stable `gpu_uuid` from the PCI bus
    since ROCm doesn't expose a unique ID like NVIDIA's.
  - `gpuRocm` / `processesRocm` collectors mirror the nvidia
    versions' contracts; shared `/proc` helpers extracted to
    `_procTicks.ts` so the two paths don't drift.
  - `docker-compose.agent.amd.yml` quickstart with `/dev/kfd` +
    `/dev/dri`, group_add for `video` / `render`, `/opt/rocm`
    bind-mount, and `LD_LIBRARY_PATH` so the rocm-smi ctypes loader
    finds `librocm_smi64.so.1` inside the container. README has a
    dedicated **AMD / ROCm support (experimental)** section.
- **Hub now persists remote-agent samples to SQLite.** The agent
  ingest path emitted samples only to the in-memory metrics bus,
  so a freshly enrolled host appeared online but its
  `/api/gpu/devices` returned empty and the UI showed "Aucun GPU
  détecté". New `agentMetricsPersistor` service subscribes to the
  bus, skips `LOCAL_HOST_ID` (already covered by `gpuCollector`),
  upserts device rows inline and buffers metric rows for a 60 s
  flush — mirrors the local collector pattern.
- **Agent `TZ` / `TLS_INSECURE` ergonomics.** Both env vars are now
  threaded through `docker-compose.agent*.yml` with `${VAR:-default}`
  substitution, and the agent image ships `tzdata` so `TZ=Europe/
  Paris` actually moves clock-on-log to local time. `TLS_INSECURE=1`
  is documented as acceptable for self-signed certs on a private
  LAN but never over the open Internet.
- **`gpuviewr-agent` Docker image now publishes to GHCR.** The
  Docker workflow grew a matrix job that builds both `gpuviewr`
  (hub) and `gpuviewr-agent` in parallel with independent cache
  scopes. The agent image reference in `docker-compose.agent*.yml`
  finally resolves to a real `ghcr.io/erreur32/gpuviewr-agent:
  latest`; previously it pointed at a non-existent tag and users
  had to fall back to `install.sh` bare-metal.

### Changed
- **Agent runtime base bumped from `node:22-bookworm-slim` to
  `node:22-trixie-slim` (glibc 2.41).** Required for the AMD path:
  modern ROCm builds need `GLIBC_2.38` / `GLIBCXX_3.4.32`, and
  bookworm's 2.36 caused the bind-mounted `librocm_smi64.so.1` to
  fail to load (silently — the script printed an error on stderr
  but exited 0). The hub image stays on bookworm; only the agent
  needs to match host-side AMD libraries.
- **Agent image now includes `python3`, `tzdata`, and
  `libdrm-amdgpu1`.** `python3` is required because `rocm-smi` is a
  Python script that imports `json`/`argparse`/`subprocess` from
  the stdlib. `tzdata` honors the `TZ` env var. `libdrm-amdgpu1`
  silences the cosmetic "Fail to open libdrm_amdgpu.so" warning
  rocm-smi prints on every tick.
- **Main `docker-compose.yml`: NVIDIA runtime is now opt-in.** The
  `runtime: nvidia` + `deploy.resources.reservations.devices`
  block is commented out by default so the hub starts on any host
  (AMD, no-GPU, dev laptop) in "control plane" mode. Uncomment for
  local NVIDIA passthrough — the hub still picks up GPUs from
  enrolled agents either way.

### Fixed
- **Agent `Dockerfile` digest pins were stale.** Both the
  `node:22-bookworm-slim` builder and the previous distroless
  runtime referenced digests that no longer existed upstream, so
  the Docker workflow's agent matrix job (added this release)
  failed every build. Pins refreshed as part of the trixie bump.
- **`_rocmParsers.ts` SonarCloud cleanup.** Replaced a regex flagged
  for super-linear backtracking risk (S5852) with a char-by-char
  walker, threaded optional chains through the `if (!x ||
  !x.trim())` guards, and split `parseRocmPids` into a top-level
  loop + helper so cognitive complexity drops from 21 to under 15.
  No behaviour change; the 21 parser tests still pass on the same
  Strix Halo fixtures.

## [0.3.0] - 2026-05-15

### Added
- **Remote-agent GPU processes.** Agents now ship a `processes`
  frame on the `/agent` WebSocket alongside GPU samples. The agent
  collector runs `nvidia-smi --query-compute-apps` + `nvidia-smi pmon`
  in parallel and enriches each row with `/proc/<pid>/cmdline` and
  delta-based CPU%. The hub keeps a per-host in-memory snapshot
  (30 s TTL) so `/api/processes?host=<id>` serves real data for
  agent hosts — the route's "reserved for a later release" stub is
  gone. The Dashboard's GPU-processes table forwards
  `selectedHostId` and shows a `reason` hint when an agent's
  capability is off or its snapshot is stale.
- **Mock agent seeder (dev only).** `MOCK_GPU=1` now also registers
  a synthetic `mock-agent-1` host that emits fake samples + fake
  processes every tick, so `dev:mock` exercises the multi-host
  process path without a real agent connection.
- **Fleet GPU cards in "Jauges" mode.** Each per-GPU mini tile now
  renders four System-style arc speedometers (util / temp / power /
  memory) with the same 5-band gradient, glow filter, and
  `gauge-pulse` danger animation as the System page. Layout
  collapses to 2×2 below 640 px and stretches to a single row from
  `sm:` upward.
- **Alerts events table — exact time.** Each event now shows the
  absolute `HH:MM:SS` (with date prefix on different days) below the
  existing relative-time pill; full datetime is in a hover tooltip.
- **Multi-host architecture (jalons 1-5 of the [multi-host plan](Docs/MULTI_HOST_PLAN.md)).**
  The hub can now aggregate metrics from remote GpuViewR agents on top of
  its own `nvidia-smi`. Each metric row, device row and alert event is
  tagged with a stable `host_id`; the legacy local install is the
  reserved id `local` and remains zero-touch.
- **`/api/hosts` REST surface.** CRUD + enrollment (admin only) that
  returns a one-shot bcrypt-hashed token; rotate-token endpoint; status
  endpoint exposing `last_seen` / `lag_seconds`.
- **`/agent` WebSocket ingest.** Agents authenticate via the
  enrollment token (bcrypt-compare server-side). The session-bound
  host id is authoritative — any host id in incoming frames is
  ignored, so a compromised agent can't impersonate another host.
  Rate-limited at 100 msg/s/session.
- **Hosts watchdog.** A 5 s tick flips agents that haven't been seen
  in 30 s to `status='offline'`. Status changes are forwarded to
  the UI via `/ws/gpu`.
- **`/agent` standalone package** (`/agent` directory). TypeScript
  Node 22, bundled to a single ~17 KB `.mjs` via esbuild, packaged
  as a distroless Docker image. Reuses the hub's `_nvidiaParsers.ts`
  so any driver-format quirk fix lands in one place.
- **`docker-compose.agent.yml`** drop-in for remote hosts.
- **Alert rules** gained an optional `host_id` scope (NULL = global,
  symmetric with the existing `gpu_index NULL = all GPUs`).
- **`/api/health`** now reports `hostsTotal` / `hostsOnline` /
  `hostsLagging` / `hostsOffline`.
- **`?host=` query param** on `/api/gpu/{current,history,history.csv,stats}`
  and `/api/processes/`. Defaults to `local` for backward compat.

### Changed
- **Dashboard / System view toggle relabelled.** The `Bars` /
  `Barres` button is now `Compact` (en + fr) since the alternative
  to gauges is a compact bar layout, not just "bars".
- **Fleet view toggle relabelled + reordered.** The fleet's
  density toggle is now `Jauges` / `Compact` (was `Détaillé` /
  `Compacte`), with Jauges first to match the Dashboard and System
  selectors. Same `LayoutGrid` / `BarChart3` icon pair across the
  three pages for muscle-memory consistency.
- **System Temperatures hero card is no longer tinted.** The outer
  hero frame on the Températures panel now uses a static
  `surface-alt` background with a plain border. CPU/GPU sub-frames
  inside still carry the temperature-driven accent; removing the
  outer wash keeps the panel calm at high temperatures.
- **System Temperatures heatmap label renamed** from
  `Carte thermique` / `Thermal map` to `Carte mère` / `Motherboard`,
  since the heatmap strip is built from motherboard hwmon sensors.
- **System PCIe Connectivity panel compacted.** Title, link
  bandwidth (with / max), PCI slot id and PCIe gen × width are now
  laid out on a single wrap row instead of a 3-section stack —
  saves ~40 px of vertical space per GPU card.

### Changed (breaking for export consumers)
- **Prometheus**: every series now carries a `host="<id>"` label
  (`local` for mono-host installs). A `gpuviewr_host_info{host=<id>} 1`
  side-metric per host lets Grafana join human labels via
  `* on(host) group_left(label) gpuviewr_host_info`. Hub-system
  metrics renamed their `host=<hostname>` dimension to
  `os_hostname=<hostname>` to free the `host` label for host_id.
- **InfluxDB**: new `host=<id>` tag on every GPU line. The host
  measurement renamed `host=<hostname>` → `os_host=<hostname>`.
- **MQTT**: topic shape moved from `gpuviewr/gpu<N>/state` to
  `gpuviewr/<host_id>/gpu<N>/state`. HA Discovery unique_ids and
  device identifiers similarly prefixed by host id.
- **Webhook**: payload gained `samples_by_host`. The flat `samples`
  array is kept for forward compatibility with v0.2.x receivers.

See [Docs/MIGRATION.md](Docs/MIGRATION.md) for upgrade notes and
Grafana / HA / Influx migration snippets.

## [0.2.6] - 2026-05-15

### Security
- **Rate-limit on `/install.sh` and `/agent.mjs`** (CodeQL #42/#43).
  A dedicated `installLimiter` (30 req/min/IP) is now applied at the
  router level; the comment header that already claimed
  rate-limiting is now actually true.
- **`agent/Dockerfile`** now uses `npm ci` against the pinned
  lockfile instead of `npm install`, so builds are reproducible
  (Scorecard Pinned-Dependencies #39).
- **`agent/install.sh.tpl`** no longer pipes
  `https://deb.nodesource.com/setup_22.x` into bash. The NodeSource
  APT/DNF repository is now registered manually with the GPG key, so
  the install script never executes unaudited remote shell code
  (Scorecard Pinned-Dependencies #40/#41).
- **`crypto.getRandomValues`** replaces `Math.random` in the demo's
  `mockApi` token suffix (Sonar S2245). The value is cosmetic and
  the file only runs in demo builds, but the static analyzer is no
  longer noisy.

### Added
- **Fleet `/fleet` range selector.** `FleetChart` now mirrors the
  Dashboard's `RangeSelector`. `live` keeps the rolling 60s in-memory
  window; longer ranges (`5m` … `3d`) fetch `/gpu/history` per
  (host, gpu) and aggregate per host.
- **Compact tile design on the Fleet "simple" view.** Each host card
  shares the same `MetricRow` component as the Dashboard's "All GPUs"
  page — progress-bar metrics (util / memory / temperature / power),
  a per-host util sparkline and a PCIe / agent footer.
- **Footer WS pill tooltip.** The "Live" / "Offline" badge now has
  an explanatory `title` attribute (en + fr) so a new visitor
  understands what it's tracking.

### Changed
- **Fleet density toggle renamed** "Simple/Detailed" → Compact/Bars
  ("Compacte/Barres" in fr), matching the new tile layout.
- **Footer WS pill is i18n-resilient.** `t('common.connected' /
  'common.disconnected')` now passes a `defaultValue`, so a stale
  service-worker cache that ships a JS bundle from before those keys
  existed can no longer surface the raw key in the UI.
- **Modal accessibility.** All modal backdrops (EnrollHost,
  RotateToken, DeleteHost) use real `<button>` overlays with an
  Escape-key handler, and segmented controls switched from
  `role="group"` to `role="toolbar"` with an `aria-label`.

### Fixed
- **30+ SonarCloud findings cleared in a single sweep.** Highlights:
  `exportService.metricsSummary` split into focused helpers
  (cognitive complexity 21 → well under 15), negated ternaries
  flipped, `void operator` and unused imports removed, nested
  ternaries extracted, unnecessary type assertions dropped,
  `window.*` → `globalThis.*`, `alerts.ts` `host_id` coercer
  narrowed via `typeof`, `clipboard.ts` uses `childNode.remove()`
  with a documented `execCommand` fallback for insecure contexts.

### Demo
- **`?fleet=1` deep-link entry.** When a visitor lands on the base
  URL with `?fleet=1`, `bootstrapDemo` `replaceState`s to `/fleet`
  before React mounts, so the multi-host UI is the first screen they
  see (no flash of the single-host dashboard). README updated to
  link directly to `https://erreur32.github.io/GpuViewR/fleet?fleet=1`.

## [0.2.5] - 2026-05-14

### Added
- **Progressive Web App support.** GpuViewR can now be installed as
  a standalone Chromium app via the browser's install prompt. A
  generated service worker (via `vite-plugin-pwa`) precaches the
  app shell (HTML/JS/CSS/icons) so the window opens even when the
  backend is unreachable — the existing WebSocket reconnect logic
  in `useGpuStream` then drives the footer "disconnected" pastille
  until `/api` and `/ws` come back. Live data endpoints are
  explicitly excluded from the SW's navigation fallback so metrics
  are never served stale from cache.
- **PWA icons.** New `pwa-192x192.png`, `pwa-512x512.png` and a
  maskable variant generated from `gpuviewr.svg`, plus an
  `apple-touch-icon` link in `index.html` for iOS home-screen.

### Changed
- **Demo CSP** now whitelists `manifest-src 'self'` and
  `worker-src 'self'` so the service worker registers correctly on
  GitHub Pages.

## [0.2.4] - 2026-05-10

### Fixed
- **Phantom hwmon sensors no longer leak to the UI.** The host
  thermal pipeline now applies a 5–150°C plausibility window in
  `readHostTemperatures()`, so unwired motherboard pins and
  uninitialised virtual sensors (acpitz et al.) stop surfacing as
  fake 0°C / negative readings on the System page.
- **Sonar S3776 (cognitive complexity).** Refactored
  `readHostTemperatures()` to extract per-directory and per-sensor
  helpers (`listDirSafe`, `readSensorsFromDir`, `readOneSensor`),
  bringing the function below the 15-complexity gate.

### Changed
- **System thermal panel hero is split into CPU + GPU sub-frames.**
  Each domain shows its own hottest sensor and heat bar. NVIDIA hosts
  (no GPU hwmon node) populate the GPU sub-frame from `info.gpus[]`
  via a synthetic `nvidia` source. Heatmap strip and source-grouped
  chip cards stay as before.
- **Sub-frame styling now follows theme tokens.** Inner cards sit on
  `--gv-surface` (the lift token) instead of `--gv-bg`, and the heat
  bar mirrors `SystemPage.UsageBar` (gradient base + masked trailing
  portion) for consistent contrast across light/dark themes.
- **i18n.** Added `system.temps_cpu`, `system.temps_gpu`,
  `system.temps_no_sensors` to en/fr.

## [0.2.3] - 2026-05-10

### Added
- **Host temperature sensors on the System page.** New backend module
  reads `/sys/class/hwmon/*` (CPU package, per-core temps, NVMe drives,
  ACPI thermal zones) and exposes them via `GET /api/system` under a
  new `temperatures` field. The System page renders a dedicated thermal
  panel: a glowing hero readout for the hottest sensor (with breathing
  pulse ≥ 75°C and percent-toward-critical bar), a heatmap strip of
  every reading, and source-grouped chip cards (CPU / NVMe / ACPI…)
  with per-chip heat fill. Panel is collapsible and the state persists
  across reloads. Other System graphs are untouched.
- **Live demo refreshed.** Synthetic hwmon sensors (coretemp package +
  8 cores, NVMe Composite/Sensor1/Sensor2, ACPI thermal) wave over time
  so the demo's new thermal panel animates alongside the GPU mocks.

### Changed
- **Unified metric order across the entire UI.** Cards, gauges, chart
  legends, tooltip rows, alert metric selectors, threshold/colour
  pickers and webhook payload field lists now read in the same order
  everywhere: utilization → memory → fan → temperature → power. Prior
  pages mixed several orderings. Affected: Dashboard, All-GPUs grid,
  StatsSection, LiveChart, MultiGpuChart, SettingsPage colour & threshold
  pickers (and the theme preview gradient), AlertsPage METRIC_ORDER,
  ExportsSettings webhook fields, plus the demo Prometheus / MQTT /
  Influx / webhook samples.

## [0.2.2] - 2026-05-05

### Changed
- Alerts tab: rules table split into GPU / System groups with category
  headers; per-rule "All GPUs" subtitle removed for cleaner rows.

### Added
- Alerts tab: per-event delete button (appears on row hover) and "Clear
  all" button to remove all events at once. Backend: DELETE
  /api/alerts/events/:id and DELETE /api/alerts/events routes.

## [0.2.1] - 2026-05-05

### Changed
- Alerts tab: Rules section is now collapsed by default, showing a rule
  count. It auto-expands when a rule is created or presets are installed,
  so Recent Events stay visible instead of being buried below a large
  rules table.
- Alerts tab: rules table split into GPU / System groups with category
  headers; per-rule "All GPUs" subtitle removed for a cleaner row layout.
- Alerts tab: Recent Events now show the metric icon, a pulsing status
  dot for firing alerts, a colored state badge, and relative timestamps.

## [0.2.0] - 2026-05-05

A public browser-only demo lands on GitHub Pages, the Dashboard gains
an "All GPUs" overview with a combined live chart, and the gauge-view
selector is dropped from Settings (each tab now keeps its own choice).

### Added
- **Public demo build for GitHub Pages.** `npm run build:demo`
  produces `dist-demo/` (~235 KB gzip), which the new
  `.github/workflows/pages.yml` deploys to
  https://erreur32.github.io/GpuViewR/. The bundle ships zero secrets,
  installs a `fetch` + `WebSocket` mock that returns deterministic fake
  data for two synthetic GPUs (RTX 4090 + RTX 3080), and shows a
  persistent "DEMO MODE" banner. Strict CSP (`default-src 'self'`,
  `connect-src 'self'`, no inline scripts) and `noindex` meta are
  injected only in the demo HTML.
- **"All GPUs" dashboard view.** A new "All" button in the GPU tabs
  bar (Layers icon) renders every device side by side in a responsive
  grid (1 / 2 / 3 columns). Each tile shows a header (name + index +
  driver), a top-right utilization sparkline, five compact metric
  bars (Temp / Util / Mem / Fan / Power) coloured by status, and a
  PCIe link footer with RX / TX inline.
- **Combined live chart in the All-GPUs view.** One uPlot line per
  GPU on a single chart, with a metric selector (Util / Temp / Mem /
  Fan / Power), an 8-colour palette and a tooltip that compares
  every GPU at the cursor's instant.
- Live demo link in `README.md` right under the tagline.

### Changed
- **Sparkline gradient fix.** Every sparkline used a fixed
  `<linearGradient id="sl-grad">`, so SVG-defs collisions made all
  gauges paint with the wrong colour. The id is now generated via
  `useId()` so each instance owns its gradient. Stops widened from
  2 to 3 (45 / 12 / 0 %) for crisper definition.
- **Gauge view setting removed from Settings → Theme.** The gauge /
  bar toggle stays on each tab (Dashboard, System) and the two are
  independent: clicking a mode on Dashboard no longer touches System.
- Hardcoded `/GPUViewR.png` and `/alert.mp3` paths now go through
  `import.meta.env.BASE_URL`, so the icons and the alert sound work
  under both `/` (production) and `/GpuViewR/` (GitHub Pages).
- Build & Push Docker Image workflow gained a `workflow_dispatch`
  trigger so manual rebuilds for upstream OS patches no longer need a
  no-op commit.

### Internal
- New `dashboardView` flag on `uiStore` (`'single' | 'all'`),
  persisted under `gpuviewr.dashboard_view`. `selectedGpu` stays an
  index so the per-GPU choice survives mode switches.
- `vite.config.ts`: `VITE_BASE_PATH` env var drives the build base,
  output switches to `dist-demo` when `VITE_DEMO=1`, and a tiny
  inline plugin injects the CSP / noindex meta only in the demo
  HTML.
- sonar(S5332): demo placeholder URLs (Influx, Prometheus endpoint)
  flipped from `http://` to `https://`.

## [0.1.43] - 2026-05-04

Host stats reach every exporter (Prometheus, MQTT, InfluxDB, Webhook),
host-scoped alert presets land, the MQTT settings get a layout pass,
and the Home Assistant help block is restyled.

### Added
- **Host metrics on every exporter (toggle).** Each exporter has a new
  `includeSystemStats` setting (off by default):
  - **Prometheus** exposes `gpuviewr_host_*` gauges on `/metrics`
    (CPU usage ratio, load 1m / 5m / 15m, memory used bytes / ratio).
  - **MQTT** publishes a retained JSON message on
    `<prefix>/host/state`, and emits HA discovery for the host sensors
    when `haDiscovery` is also on.
  - **InfluxDB** writes one extra point per push to
    `<measurement>_host` with cpu_usage_pct, load 1m / 5m / 15m and
    memory_used_pct.
  - **Webhook**: was already exposed in 0.1.41; now mirrored across
    the other three. The toggle is per-exporter so each can be turned
    on independently.
- **Host-scoped alert presets.** `AlertMetric` extended with
  `host_cpu`, `host_load_1m`, `host_memory`. New presets land
  disabled like the GPU ones:
  - Host CPU critical (> 95% / 60s, sound)
  - Host CPU high (> 85% / 120s)
  - Host load high (> 4.0 / 120s — calibrated for ≥ 4 cores)
  - Host RAM saturated (> 95% / 30s, sound)
  - Host RAM high (> 90% / 60s)
- **Host alerts in the rule editor.** Metric `<select>` is now an
  `<optgroup>` split — GPU group and Host group — and the rules table
  / presets picker order, badges and icons all extend cleanly to the
  three new metrics.
- **`gpuviewr_host` as a Home Assistant device.** When MQTT discovery
  + host stats are both enabled, host CPU / load / memory appear as a
  separate device alongside the per-GPU devices.

### Changed
- **MQTT settings layout.** Broker URL, status (connecté/disconnecté),
  push interval are now in a flat status block above the "Ce qui est
  envoyé" disclosure — text no longer overlaps the disclosure summary.
  The disclosure keeps only what describes the data being sent (topic
  pattern, active topics, host topic when applicable, payload keys,
  HA discovery sub-block).
- **MQTT toggles spaced.** "Publier les stats machine" sits in its
  own `pt-2` block under "Publier la découverte Home Assistant" with
  a clear helper. The "Sensors auto-appear in Home Assistant" tip is
  attached to the HA toggle, not floating above the system one.
- **Home Assistant help restyled.** Numbered colored badges, info-tinted
  step rows, accent-tinted inline labels (`'value'`) and info-tinted
  placeholders (`<broker-host>`). Em-dashes removed from step bodies.
  Final note rendered in a soft warn-tinted box.

### Removed (em-dashes)
- "Les règles ajoutées sont désactivées — vérifiez puis activez
  chacune." → uses `:` instead.
- HA help step 5 "en entités distinctes — utilisables" → "en entités
  distinctes, utilisables".
- EN steps 2 + 4 reworded similarly.

### Internal
- `alertService` no longer needs `as unknown as GpuSample`. The
  evaluator is typed against an `EvalSample = GpuSample | HostSample`
  union with an `isHostSample` type guard, so `readMetric` narrows
  cleanly without runtime cost.
- New shared helper `buildInfluxHostLine()` keeps the line-protocol
  format for the host point in one place; `INFLUX_HOST_FIELD_KEYS`
  drives both the writer and the dispatch panel listing.

## [0.1.42] - 2026-05-04

System tab gets PCIe RX/TX fill bars per GPU, the throughput tile
becomes a shared component reused by Dashboard and System, and a
few SonarCloud findings on the alert formatter are fixed.

### Added
- **PCIe RX/TX tiles on the System page.** Each GPU card now shows
  the same glass-style RX / TX fill bars as the Dashboard PCIe
  panel, normalized against the GPU's theoretical link bandwidth.
  In `gauge` view they sit on a single row with the Util and
  Memory gauges (`Util | RX | TX | Mem`); in `bar` view they
  appear as a 2-column row stacked between Util and Memory. Hidden
  when the driver/runtime exposes neither RX nor TX.
- **Shared `PcieThroughputTile` component.** Extracted from
  `Dashboard.tsx` to `src/components/dashboard/PcieThroughputTile.tsx`
  along with the `formatThroughput` helper, so both pages render
  identical tiles with no drift.

### Changed
- **System API exposes RX/TX.** `/api/system` now includes
  `pcie_rx_kbps` and `pcie_tx_kbps` per GPU, plumbed straight from
  the gpuCollector sample.

### Fixed (SonarCloud)
- **alertFormatter: `replace` -> `replaceAll`.** `escapeHtml`
  switches to ES2021 `String#replaceAll` for the three HTML escape
  substitutions.
- **alertFormatter: redundant ternaries removed.** The `lang === 'fr'`
  branches in `buildLines` returned identical strings; collapsed
  to a single template. Comment clarifies that `lang` still drives
  the phrase table (`I18N[lang]`).
- **alertFormatter: nested template literals flattened.**
  `hostLine` extracts `Math.round(...)` results into named
  variables before applying the bold marker, removing the inner
  template literals.

## [0.1.41] - 2026-05-04

Webhook & alert pass: localized Discord/Telegram alert messages
with bold values, optional host stats footer (CPU / load / memory),
preset deduplication and category-grouped rule list, plus a few
UI polish fixes on the System cards and the chart legend.

### Added
- **Localized Discord/Telegram alert messages.** New
  `server/services/alertFormatter.ts` builds a single message in
  English or French (per-webhook setting), with values rendered in
  bold (Markdown for Discord, HTML for Telegram). The plain text
  also lands in the generic JSON payload as a `messages` block.
  Wording mirrors the in-app "Recent events" row, e.g. *"Utilization
  above 80% (observed 93%) on GPU #0"*.
- **Webhook language setting.** New `language` field on
  `WebhookConfig` (`en` / `fr`, default `en`), exposed in
  Settings → Exports → Webhook (visible in alerts mode). Test
  webhook now sends a synthetic firing alert through the same
  formatter so the preview matches what real alerts will look like.
- **Host stats in webhook payloads.** New
  `server/services/systemStats.ts` exposes shared CPU usage / load
  averages / memory usage. Discord and Telegram alert messages get
  a `Host: CPU X% · Load 1.2 / 0.8 / 0.5 · MEM Y%` footer (FR:
  `Hôte : CPU X% · Charge … · Mém Y%`) and the generic JSON payload
  receives a top-level `system` block. Toggleable per webhook via
  the new `includeSystemStats` setting (default on).
- **Logo deep-link.** Clicking the logo in the header now opens
  `/settings/about` (the title still goes to the dashboard).

### Changed
- **Alerts page: rules grouped by metric category.** The rules
  table is now sorted in a stable order — temperature first, then
  utilization, memory, power, fan_speed — secondary sort by
  threshold and name. Same `METRIC_ORDER` is reused by the presets
  picker so both lists stay consistent.
- **Presets picker: no duplicates.** Already-installed presets are
  detected by `(metric, condition, threshold)`, default-deselected,
  greyed out and disabled, with an "Already added" / "Déjà ajoutée"
  badge. Prevents reinstalling the same rule twice.
- **System page: gauges aligned across cards.** Host / CPU / Memory
  cards switch from `space-y-3` to `flex flex-col gap-3` with
  `mt-auto` on the gauge wrapper, so the gauges dock at the bottom
  of each card. CPU's wrapped meta line no longer pushes its
  gauge below the others.

### Removed
- **Chart legend "reset color" `×` button.** The little `×` next to
  a custom-colored chip looked like a "delete legend" affordance
  but only reset the colour. Removed entirely; the show/hide click
  on the label and the colour-picker on the swatch are unchanged.
  The white border on the swatch still flags a custom colour, and
  re-picking the original colour reverts the override.

## [0.1.40] - 2026-05-04

Dashboard polish pass: fill-bar previews on PCIe RX/TX tiles, a
cleaner Arc gauge, removal of the broken legend "pin" click, and
a dev-mode mock that now sweeps every gauge through its full
range so theme/gradient tweaks can be previewed without a real
GPU.

### Added
- **PCIe RX/TX fill bars.** The RX and TX tiles now display a
  glass-style fill that scales with traffic relative to the
  link's theoretical bandwidth. Log-scaled so idle traffic is
  still visible without being lost in the noise of a saturated
  PCIe 4.0 x16 link. Gradient is anchored to the full tile
  width and revealed via `clip-path`, so the dark band stays at
  the left edge and the bright tip stays at the right edge
  regardless of value.
- **Theme-aware gradient stops.** The PCIe fill now ends at
  `var(--gv-info)` (no white mix) and starts from
  `mix(info, var(--gv-bg))`, so the effect stays subtle in dark
  themes and doesn't wash out in light themes.

### Changed
- **Bar gauge gradient.** The temperature / utilization /
  memory / fan / power bars use a 3-stop gradient
  (sombre -> pleine couleur -> leger eclat) anchored to the
  full track, with `clip-path` reveal so the dark band stays
  fixed.
- **Arc gauge simplified.** Stroke thickened from 8 to 13,
  gradient reduced to a clean dark->bright fade in the gauge's
  status colour (no more white over-glow). Warn/danger tick
  marks remain.
- **Memory tile.** Removed the redundant `MiB` from the primary
  value (`20 760` instead of `20 760 MiB`); the unit is still
  shown on the `/ 24 576 MiB` sub-line.
- **MiB/s legibility.** The PCIe throughput unit (`KiB/s`,
  `MiB/s`, `GiB/s`) is now tinted with `--gv-info` instead of
  `--gv-text-dim`, fixing low contrast on dark themes.

### Removed
- **Chart "pin" click.** Clicking on the live chart no longer
  toggles a frozen-cursor mode (the feature was unreliable). The
  hover tooltip and keyboard interactions are unchanged. Unused
  `dashboard.click_pin` / `dashboard.click_unpin` translation
  keys removed.

### Dev / Mock
- **Full-range sweeps.** `MOCK_GPU=1` now uses a clean
  `sweep(min, max, period, phase)` helper for utilization, temp,
  fan, power, memory and PCIe RX/TX, so every gauge visits both
  extremes during a session - handy for previewing gradients
  and warn/danger thresholds in `npm run dev` without a real
  GPU. RX/TX sweep up to 95% of each device's theoretical PCIe
  link bandwidth (PCI-SIG per-lane x width).

## [0.1.39] - 2026-05-04

Smaller, less noisy PCIe panel on the System tab. The ASPM idle-
downshift explanation moves out of an inline paragraph into a
hover/focus tooltip behind a small info icon, and the
"Connectivité PCIe" card is rearranged to drop a full row of
height per GPU.

### Changed
- **PCIe bandwidth hint -> info tooltip.** The two-line hint
  paragraph that explained "NVIDIA cards downshift the link gen
  at idle, so 4.00 GB/s vs. 15.76 GB/s max is normal" is gone
  from the layout. A small info icon next to the value reveals
  the same text on hover or keyboard focus, in a CSS-only
  tooltip with a `title` fallback for accessibility.
- **Denser PCIe card.** Vertical padding shrinks from `p-3` to
  `px-3 py-2`, the bandwidth label is now inline with the value
  on a single row instead of stacked above, and the inter-row
  gap is `space-y-1.5`. The Slot / Link grid is unchanged. Net
  result: about 40% less height per GPU PCIe panel.
- **Theme-safe tooltip colours.** The tooltip relies only on
  `--gv-surface`, `--gv-text`, `--gv-border`, `--gv-bg` and
  `--gv-accent` (the same variables every theme already
  defines), so it renders correctly on Midnight, Graphite,
  Oceanic and any future light theme — no hard-coded hex
  values.

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
