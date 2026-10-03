# Integration plan: GpuViewR agent on macOS / Apple Silicon (Metal)

> **Status (updated 2026-10-03, current release v0.9.18)**: implemented and
> shipped in **v0.9.0** (2026-09-14): `powermetrics` collector
> (`agent/src/collectors/gpuMacosPowermetrics.ts`, with `plist.ts` and
> `macosSysctl.ts`), `install_mode` `macos` in the agent
> (`agent/src/transport.ts`) and the hub (auto-update included),
> `agent/install.sh.mac.tpl` served at `/install.mac.sh`, and the hub UI
> (macOS icon, 4th tab in `InstallModePicker`, "Unified" memory label).
> The optional `macos-14` CI job was not added. The GPU process list is
> still not collected on macOS (on hold, see §2.4).
>
> **Not validated on real hardware**: the collector has only been tested
> against synthetic plist fixtures built from public documentation, never
> against a real `powermetrics` capture. The install script has never run
> on a real Mac either. If you have an Apple Silicon Mac, see
> [Help the macOS agent](../agent/README.md#help-the-macos-agent).
>
> This document is the original pre-implementation plan, written on
> 2026-05-25 by the Plan agent and followed as-is from 2026-09-14 (no
> separate review beforehand). File and line references describe the code
> base at the time of writing unless marked as updated.

## 0. Preliminary strategic recommendations (to settle before writing code)

**TO DECIDE 1, Hardware scope**: target **Apple Silicon only (M1+, arm64)**.
Covering Intel Macs with an AMD dGPU is technically feasible
(`powermetrics --samplers gpu_power` works there too) but the market is marginal
(Mac Pro 2019, iMac Pro), Apple dropped NVIDIA after 10.14, and the memory
architecture is different (dedicated VRAM vs unified). Recommendation: **darwin-arm64
only** for v1, open darwin-x64 later if users ask for it.
All paths below assume this choice.

**TO DECIDE 2, Privileges**: see §3. Strong recommendation: **targeted sudoers
NOPASSWD on `/usr/bin/powermetrics`** rather than a root LaunchDaemon.

**TO DECIDE 3, Distribution**: keep the "single `agent.mjs` bundle run by the
system Node" model (consistent with Linux/Windows). No
`pkg`/`sea`/`bun compile` binary. See §7.

---

## 1. Target architecture

### 1.1 Platform detection

The current `process.platform === 'win32'` selector in
`agent/src/index.ts` must be extended with
`process.platform === 'darwin'`. Approach: introduce in `agent/src/index.ts`
a local `IS_DARWIN`/`IS_WIN`/`IS_LINUX` constant computed once,
and branch `resolveVendor` + `buildGpuCollector` on it.

### 1.2 New collector

File: `agent/src/collectors/gpuMacosPowermetrics.ts`

Same contract as the 4 existing collectors (`gpu.ts`, `gpuRocm.ts`,
`gpuAmdgpuSysfs.ts`, `gpuWindowsPdh.ts`), i.e. export a
`createMacosPowermetricsCollector(opts)` returning
`{ start, stop, available }: GpuCollectorHandle`. Closest pattern to copy:
**`gpuWindowsPdh.ts`**, because it has the same topology (long-running spawn of a
native helper that pushes JSON on stdout, which Node parses line by line) rather than
the "spawn per tick" model of `gpu.ts`. This matters because `powermetrics` has a
warmup cost of ~500ms-1s to initialize its samplers, and spawning once per tick
would drain a laptop's battery.

### 1.3 Wiring into `resolveVendor` and `buildGpuCollector`

In `agent/src/index.ts`:

- Introduce a `GpuVendor` type extended to `'auto' | 'nvidia' | 'amd' | 'apple'`
  in `agent/src/config.ts`. The `parseGpuVendor` parser
  recognizes the value `apple`.
- `resolveVendor()`: add
  `if (process.platform === 'darwin') return 'apple';` right after the explicit
  return of `cfg.gpuVendor`. Apple Silicon has no other relevant GPU
  to probe; returning `'apple'` is safe.
- `buildGpuCollector()`: new branch
  `if (v === 'apple') return createMacosPowermetricsCollector(...)`.
- The process collector (`processes.ts`) is currently blocked by
  `process.platform === 'win32'`; replace the guard
  with `if (process.platform !== 'linux' && config.features.processes)` with
  a suitable message ("processes disabled on macOS: no /proc, no nvidia-smi
  pmon. GPU sampling continues."). See §2.4 for the Mac process strategy.
  (Update, v0.9.17: Windows now has its own process collector, so the
  guard in `index.ts` is darwin-specific: a warning is logged and no
  process collector is started on macOS.)

### 1.4 Install mode

In `agent/src/transport.ts`, extend the `InstallMode` type to
`'docker' | 'systemd' | 'windows' | 'macos' | 'unknown'` and make
`detectInstallMode` return `'macos'` when `process.platform === 'darwin'`.
On the hub side, `server/database/models/Host.ts:23` must accept the same value.
The typecheck will already complain at the places where `install_mode` is tested on the hub
(`server/services/agentIngestWS.ts`); update them to allow
auto-update on macOS (see §8).

---

## 2. Metrics collection strategy

### 2.1 powermetrics command to use

Recommended form for the long-running spawn:

```
sudo powermetrics --samplers gpu_power,smc -i 1000 -f plist
```

Notes:

- `-f plist` (alias `--format plist`) pushes one XML plist per sample, separated
  by `\x00` (`NUL`). This is the documented and stable format. JSON is **not**
  an output format supported by powermetrics up to macOS 14. **Do not**
  parse the human text format, it already changed between macOS 12 and 14.
- `-i 1000` = interval in ms. Aligned with `config.tickMs`.
- `--samplers gpu_power` gives: GPU utilization (`GPU active residency` %),
  frequency (`GPU HW active frequency`), energy (`GPU Power` mW). On
  M1/M2/M3/M4 the exact list of keys varies slightly (M3+ adds per-cluster
  residencies); the parser must be tolerant.
- `--samplers smc` gives the SMC probes (CPU/GPU package temperature). On M1
  it is limited, on M2+/M3+ it exposes `GPU die temperature`.
- **No** `-n` option for the long-running spawn; we want a continuous stream, not N
  samples then exit.

Node-side plist parser: use `node:stream` + a buffer delimited on
`\x00`, then a mini plist parser. Do **not** depend on an npm package
(the implicit repo rule is zero deps other than `ws`, see
`agent/package.json:18-20`). Apple plist is XML; a naive regex parser on
`<key>...</key><integer>...</integer>` covers the needs and is testable
with fixtures (see §11). Otherwise adding a `fast-plist` dependency or equivalent
(~30 KB) **is acceptable if justified** but needs discussion.
(Update: implemented as a dependency-free parser in
`agent/src/collectors/plist.ts`.)

### 2.2 Mapping to the `GpuSample` schema

The contract is `server/services/parsers/nvidia.ts:26-48`. Recommended mapping:

| `GpuSample` field | macOS source | Note |
|---|---|---|
| `gpu_index` | `0` | single integrated GPU, always 0 |
| `name` | `sysctl -n machdep.cpu.brand_string` or `system_profiler SPDisplaysDataType` | one-shot when the collector boots; e.g. "Apple M2 Max" |
| `uuid` | `null` | no GPU UUID concept on Apple Silicon |
| `driver_version` | macOS version via `sw_vers -productVersion` | reasonable proxy, the "driver" is the kernel |
| `temperature` | `GPU die temperature` key from the `smc` sampler | in °C; `0` if unavailable (M1, see §2.5) |
| `utilization` | `100 - (GPU idle residency)` or `GPU active residency` depending on the sampler | in %; integer 0-100 |
| `memory_used` | **TO DECIDE 4** (see §2.3) | in MiB |
| `memory_total` | `sysctl hw.memsize` (total RAM in bytes) / 1024 / 1024 | unified memory: everything is shared |
| `power` | `GPU Power` from the `gpu_power` sampler | mW to W (divide by 1000) |
| `fan_speed` | `null` | iMac/Mac Studio have fans but they are not exposed via powermetrics; SMC does expose them but out of scope for v1 |
| `clock_graphics` | `GPU HW active frequency` | MHz |
| `clock_memory` | `null` | unified memory has no separate clock |
| `pci_bus_id`, `pcie_*` | `null` | not applicable (GPU on the SoC) |

### 2.3 The "VRAM" question on unified memory, TO DECIDE 4

This is the most subtle design decision. Three options:

**Option A (recommended)**: `memory_total` = total Mac RAM, `memory_used`
= **memory pressure × total** derived from `vm_stat` (the "wired" +
"compressed" pages are not a good proxy for "VRAM used by the GPU").
Downside: the gauge will also rise because of CPU processes, not only
GPU. The UI shows "Memory", not "VRAM"; clear docs that this is system
memory pressure.
(Update: implemented in `macosSysctl.ts` as active + wired + compressor
pages from `vm_stat`, capped at total RAM.)

**Option B**: `memory_total = memory_used = 0` (null), the UI already shows
`'N/A'` (see `HostCard.tsx`, `GpuMiniTile.tsx`). More honest but loses
100% of the memory gauge on Mac.

**Option C**: use `ioreg -r -c IOAccelerator` + the `Device Utilization %` key
for reserved GPU memory; heavy parsing work and not always present.
Skip for v1.

**Recommendation: A**, and on the UI side add a "Unified" badge on hosts
whose `install_mode === 'macos'` or whose capabilities contain an
`unified_memory: true` flag (to be added to the hello, see §5).

### 2.4 Processes

On macOS, without access to the Metal Performance Shaders Counter API (Apple private, not
usable without signing), we **cannot** accurately list the PIDs that use
the GPU. Options:

- **Option A**: leave `processes` disabled on macOS, exactly like on
  Windows today (see `agent/src/index.ts`). Recommended for v1.
  (Update, v0.9.17: no longer true for Windows, which has had a GPU
  process list since v0.9.17 via per-process PDH counters,
  `agent/src/collectors/processesWindowsPdh.ts`. macOS remains disabled.)
- **Option B**: `powermetrics --samplers tasks` gives per-PID GPU ms/s and "GPU
  work time"; plist format as well. Feasible but adds a lot of
  parsing, and the list is polluted anyway by every process that touches
  WindowServer. To be deferred.

**Recommendation: A for v1.** `processHandle = null` + a warn log is enough, the
hub already handles the absence (see `agentIngestWS.ts`).

(Update, 2026-10-03: the macOS process list is **on hold** until a real
`powermetrics` capture from an Apple Silicon Mac is available; the README
asks users for one, see
[Help the macOS agent](../agent/README.md#help-the-macos-agent). Planned
approach when resumed: add the `tasks` sampler (`--show-process-gpu`) to
the existing powermetrics spawn instead of a second process, report no
per-PID VRAM (unified memory, no meaningful per-process figure), and keep
only PIDs that were recently GPU-busy.)

### 2.5 Temperature without SMC

On M1 (the first Apple Silicon), `--samplers smc` often outputs nothing.
Acceptable: `temperature = 0` (the schema requires `number not null`, see
`nvidia.ts:31`), not ideal but consistent with `gpuWindowsPdh.ts:203`, which also hardcodes
`temperature: 0` when PDH does not provide it. Document that on M1 the
temperature shows "0°C" and that this is expected.

---

## 3. sudo question, privileges

`powermetrics` requires root (`task_for_pid` capability + SMC access). Two
options:

### Option (a), Agent as root via LaunchDaemon

File: `/Library/LaunchDaemons/com.gpuviewr.agent.plist`. Runs as uid 0
from boot, before user login. Simple for the powermetrics side (just
spawn it). Downside: the **whole agent** runs as root. It reads JSON from
a remote WebSocket hub as root, a bad attack surface. The bundle can
be hot-replaced by `agent_update` (see `transport.ts`), so a compromised hub
runs arbitrary code as root on every Mac.

### Option (b), Targeted sudoers NOPASSWD

The agent runs as a **user** via LaunchAgent (`~/Library/LaunchAgents/`). At
startup it spawns `sudo -n /usr/bin/powermetrics ...`. The file
`/etc/sudoers.d/gpuviewr-agent` created by the installer:

```
Cmnd_Alias GPUVIEWR_PMETRICS = /usr/bin/powermetrics --samplers gpu_power* --samplers gpu_power\,smc*
%staff ALL=(root) NOPASSWD: GPUVIEWR_PMETRICS
```

Or stricter, restricted to a dedicated `_gpuviewr` user created by the installer
(mirroring the Linux `gpuviewr-agent` user in `install.sh.tpl`).
(Update: the shipped installer writes a single-user rule instead,
`${USER} ALL=(root) NOPASSWD: /usr/bin/powermetrics`, with no argument
restriction and no dedicated user.)

**Recommendation: (b)**. Root surface limited to `powermetrics` itself
(a signed Apple binary), the agent stays a user process. A classic pattern on macOS (see
what `iStat Menus` and the open source `stats` do). The installer must run `visudo -c`
to validate the syntax before installing.

Agent code side: the spawn becomes
`spawn('sudo', ['-n', '/usr/bin/powermetrics', ...args])`. The `-n`
(non-interactive) means that if sudoers is misconfigured, sudo fails
immediately instead of prompting (which would not work in a headless
LaunchAgent). The collector must detect this case in `available()` by running
`sudo -n /usr/bin/powermetrics -h` at boot (exit 0 = ok, non-zero exit with
stderr containing "askpass" or "password is required" = log an
explicit error and stop the collector, like `gpu.ts`).

---

## 4. Install script

### 4.1 Structure

New file: `agent/install.sh.mac.tpl` (the `.mac.` distinguishes it
from the existing Linux-only one, see `install.sh.tpl:64`, which explicitly dies
on non-Linux).

**Alternative discussed**: extend `install.sh.tpl` with a
`case "$(uname -s)" in Linux) ... ;; Darwin) ... ;; esac` branch instead of a
separate file. My view: **separate file**, because the flow is very different
(LaunchAgent vs systemd, brew vs apt/dnf, sudoers vs systemd hardening).
Unifying them costs more in readability than it brings. The hub route
`agentDistribution.ts` can serve both under distinct URLs
(`/install.sh` Linux, `/install.mac.sh` macOS).

### 4.2 Script steps

Draw heavily on `install.sh.tpl` and on `install.ps1.tpl` for the
Windows pattern (re-install lifecycle, kill the old launcher before re-registering,
a pattern implicitly documented in `install.ps1.tpl`).

```
1. set -euo pipefail
2. [[ "$(uname -s)" == "Darwin" ]] || die "macOS only. Use install.sh for Linux."
3. ARCH=$(uname -m); [[ "$ARCH" == "arm64" ]] || warn "Intel Mac: powermetrics works, but unified-memory mapping assumes Apple Silicon."
4. Parse --url --token --interval --features --uninstall, same flags shape as install.sh.tpl.
5. Uninstall path FIRST (as in install.ps1.tpl):
     launchctl unload ~/Library/LaunchAgents/com.gpuviewr.agent.plist 2>/dev/null
     rm -f ~/Library/LaunchAgents/com.gpuviewr.agent.plist
     rm -rf /usr/local/var/gpuviewr-agent  # or ${HOME}/Library/Application Support/GpuViewR-Agent
     sudo rm -f /etc/sudoers.d/gpuviewr-agent
     exit 0
6. Token parsing: identical to Linux (install.sh.tpl).
7. Node 22 pre-flight: command -v node, check major. If missing, suggest `brew install node@22`. Do NOT auto-install brew (intrusive, brew install asks for the sudo password, handles non-interactive mode poorly).
8. powermetrics pre-flight: command -v powermetrics, otherwise die.
9. Create the install dir: ${HOME}/Library/Application\ Support/GpuViewR-Agent/ (macOS user-scope convention) OR /usr/local/var/gpuviewr-agent for a system-wide install. Recommend user-scope since the LaunchAgent runs as the user.
10. Download the bundle: curl -fsSL "${HTTP_URL%/}/agent.mjs" -o "$INSTALL_DIR/agent.mjs" (identical to install.sh.tpl).
11. Write the sudoers file (validated with visudo -c):
       echo "..." | sudo tee /etc/sudoers.d/gpuviewr-agent
       sudo visudo -c -f /etc/sudoers.d/gpuviewr-agent || (sudo rm /etc/sudoers.d/gpuviewr-agent; die "sudoers invalid")
       sudo chmod 0440 /etc/sudoers.d/gpuviewr-agent
12. Write the env file: $INSTALL_DIR/agent.env (plain KEY=VALUE, chmod 600). The .plist sources it via EnvironmentVariables.
13. Generate the .plist (inline template; see §4.3).
14. launchctl unload (best effort, ignore errors, as in install.ps1.tpl) + launchctl load -w ~/Library/LaunchAgents/com.gpuviewr.agent.plist.
15. Print the log tail and uninstall commands (as in install.sh.tpl).
```

### 4.3 LaunchAgent template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gpuviewr.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>{INSTALL_DIR}/agent.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HUB_URL</key><string>{WS_URL}/agent</string>
    <key>HOST_ID</key><string>{HOST_ID}</string>
    <key>AGENT_TOKEN</key><string>{SECRET}</string>
    <key>TICK_MS</key><string>{INTERVAL_MS}</string>
    <key>FEATURES</key><string>{FEATURES}</string>
    <key>GPU_VENDOR</key><string>apple</string>
  </dict>
  <key>StandardOutPath</key><string>{INSTALL_DIR}/agent.log</string>
  <key>StandardErrorPath</key><string>{INSTALL_DIR}/agent.log</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
```

Note: `KeepAlive=true` is the equivalent of `Restart=always` (see
`install.sh.tpl:273`). If the agent exits on purpose after an `agent_update`
(see `transport.ts`), launchd restarts it within a second, a good match.

### 4.4 Re-install lifecycle

As on Windows (`install.ps1.tpl`), `launchctl unload` must run before
rewriting the `.plist`, otherwise the new token is never picked up
(the existing process keeps running with the old env). Pattern:

```
launchctl bootout gui/$(id -u)/com.gpuviewr.agent 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.gpuviewr.agent.plist 2>/dev/null || true
sleep 0.5
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gpuviewr.agent.plist
launchctl kickstart -k gui/$(id -u)/com.gpuviewr.agent
```

`kickstart -k` forces a restart even if the service is already running,
the equivalent of Windows `Restart-ScheduledTask` or Linux `systemctl restart`.

For the pitfalls of the Linux flow (see memory `reference_install_quirks`):
keep at least (a) the token-without-`.` bug, (b) tolerance of the
`gpvr_` prefix, (c) `http→ws` normalization and the reverse (all in
`install.sh.tpl`). Replicate them **identically** in the
Mac script.

### 4.5 Distribution from the hub

The hub currently serves `/install.sh` via `server/routes/agentDistribution.ts`.
Add `/install.mac.sh`, which serves the `agent/install.sh.mac.tpl` template with
the same `__HUB_URL__` substitution. The hub UI
(`src/components/settings/HostsSettingsTab.tsx`) must now show the **three**
one-liners (Linux / macOS / Windows). See §6.

---

## 5. DB schema and wire payload

### 5.1 Current state

The `GpuSample` contract (`server/services/parsers/nvidia.ts:26-48`) has 21
fields. All are nullable except `gpu_index`, `name`, `temperature`,
`memory_used`, `power`, `timestamp`, `timestamp_epoch`. The persistor
(`server/services/agentMetricsPersistor.ts`) writes to `gpu_metrics`
(schema in `connection.ts`), 11 physical columns; the rest (pcie, fan,
uuid) is purely transient for the live view.

### 5.2 What the macOS agent can return

| Field | Provided by Mac arm64? |
|---|---|
| `gpu_index` | yes (0) |
| `name` | yes (e.g. "Apple M2 Max") |
| `uuid` | no (null) |
| `driver_version` | proxy (macOS version) |
| `temperature` | yes on M2+/M3+, 0 on M1 |
| `utilization` | yes |
| `memory_used` | yes (depending on the §2.3 option) |
| `memory_total` | yes (hw.memsize) |
| `power` | yes |
| `fan_speed` | no (null) |
| `clock_graphics` | yes |
| `clock_memory` | no (null) |
| `pci_*` | no (null) |

**No new field is strictly required in `GpuSample`**. The
current schema is enough; anything that does not exist stays `null`, and the persistor
already accepts `null` everywhere (see `GpuMetric.ts`; only `memory_used` and
`power` are NOT NULL on the DB side, and the agent provides them).

**No DB migration needed.**

### 5.3 Capabilities / hello frame

To let the UI tell a Mac host apart and show "Unified Memory"
rather than "VRAM" (see §6), extend hello.capabilities. Today
(`transport.ts:305-310`):

```
capabilities: { gpu, system, temps, processes }
```

Proposed addition:

```
capabilities: { gpu, system, temps, processes, unified_memory?: boolean, gpu_arch?: 'cuda' | 'rocm' | 'metal' | 'wddm' }
```

The hub already stores this as a JSON string in `hosts.capabilities`
(`Host.ts:34,90`), so no DB migration. On the ingest side,
`agentIngestWS.ts:556` re-serializes it as-is. The UI reads the string and parses it
when needed.

**Simpler alternative**: use only `install_mode === 'macos'`
(see §1.4) as a proxy for "show Unified". Less flexible but zero
schema change. **Recommendation: this alternative for v1.** (Update:
this is what shipped; `capabilities` is unchanged.)

---

## 6. Hub display

### 6.1 Files to modify

All of them compute a `memory_used / memory_total` ratio and display it as
"VRAM" / "Memory". To make Mac-aware:

- `src/components/fleet/HostCard.tsx`, aggregates
  `vramUsed/vramTotal` at host level. Label `fleet.aggregate_vram`. On a
  macOS host, it should show "Unified" or a suffix.
- `src/components/fleet/GpuMiniTile.tsx`, "memory" arc gauge.
- `src/components/fleet/FleetPage.tsx`, fleet aggregate.
- `src/components/dashboard/Dashboard.tsx`, main memory
  gauge.
- `src/components/dashboard/AllGpusGrid.tsx`, per-GPU tile.
- `src/components/dashboard/MultiGpuChart.tsx`, multi-GPU chart.
- `src/components/dashboard/LiveChart.tsx`, memory history curve.
- `src/components/dashboard/StatsSection.tsx`, stats section.
- `src/components/dashboard/GpuProcessesTable.tsx`, the processes' VRAM
  column (will be empty on Mac, OK).
- `src/components/system/SystemPage.tsx`, system page.

### 6.2 Suggested pattern

Rather than touching 10 components one by one, introduce a **single helper**
`src/lib/memoryFormat.ts` (or extend an existing one) exporting
`formatMemoryLabel(host: HostRecord)`, which returns `"VRAM"` by default and
`"Unified"` if `host.install_mode === 'macos'`. Components import this
helper and replace their hardcoded label string.

For the frontend store (`src/store/gpuStore.ts` probably, to be confirmed), we
need the host's `install_mode` for each displayed sample, already available
via `/api/hosts`, which is typed `HostRecord`. Minimal plumbing.

On the i18n side (`src/i18n/locales/fr.json`, `en.json`): add `"unified_memory"`
and `"unified_memory_hint"`. Not urgent for v1; "Unified" can be passed as-is.

### 6.3 Settings UI

`src/components/settings/HostsSettingsTab.tsx` currently shows the Linux + Docker +
Windows install recipes. Add macOS:

```bash
curl -fsSL https://gpu.example.com/install.mac.sh | bash -s -- \
  --url https://gpu.example.com \
  --token <host_id>.<secret>
```

The component already has the multi-recipe logic (see the i18n key
`agent_outdated_help_both` in `fr.json:505`). Extend the enum to 4 cases.

---

## 7. Build and distribution

### 7.1 Current state

`agent/scripts/build.mjs` bundles `agent/src/index.ts` into a **single
`agent.mjs`** via esbuild in `platform: node, target: node22, format: esm` mode.
The result is ~215 KB (see `agentIngestWS.ts`). **The bundle is
platform-agnostic**, it is just JS that calls `spawn(...)`. **No
per-OS rebuild is needed.**

The current CI (`.github/workflows/ci.yml`, `docker-publish.yml`) only builds
the Docker images (linux/amd64 + linux/arm64). `agent.mjs` is included in
the hub image and served via `/agent.mjs` (see `BUNDLE_PATH`,
`agentIngestWS.ts:185`).

### 7.2 Consequence for macOS

**Nothing to do on the CI build side**. The same `agent.mjs` that Linux/Windows
download will be downloaded by Macs. Only the **runtime detection**
(`process.platform`) decides who calls `nvidia-smi` vs `powermetrics`.

This is a huge advantage of the existing design: no darwin-arm64 /
darwin-x64 / linux-x64 / linux-arm64 / win-x64 matrix to manage.

### 7.3 Caveat: Node 22 must be installed on the Mac

`agent.mjs` is a JS bundle, so it needs a system Node 22. The Mac installer must
(a) detect Node, (b) if missing, point to `brew install node@22` or
`https://nodejs.org/dist/v22.x/node-v22.x.x.pkg`. No auto-install via
Homebrew (intrusive, asks for the sudo password interactively).

### 7.4 Build test on Mac

No macOS CI runner in the project today. **Optional**: add a
`build-darwin` job to `.github/workflows/ci.yml` that runs on
`runs-on: macos-14` and does `cd agent && npm ci && npm run build && node dist/agent.mjs --version`
(only checks that the bundle loads on Mac). Cost: GitHub Mac minutes × 10
minutes per PR. **Not critical for v1.** (Update: still not added as of
v0.9.18.)

---

## 8. Auto-update

### 8.1 Current state

`transport.ts` (`applyAgentUpdate`) does an atomic swap of the bundle then
exit(0). Two paths:

- Linux: `writeFileSync(.new) + fsync + rename(.new to target) + exit(0)`,
  systemd restart.
- Windows: `writeFileSync(.pending) + fsync + exit(0)`, `launcher.ps1` swaps on
  the next loop iteration.

### 8.2 macOS path

A LaunchAgent with `KeepAlive=true` restarts the binary on `exit(0)` within
a second. The **Linux** path works as-is:
`writeFileSync(.new) + fsync + rename(.new to target) + exit(0)`. Atomic
rename(2) works on APFS (the macOS filesystem) as on ext4.

**Agent code change**: in `transport.ts:439`
(`const isWin = process.platform === 'win32'`), no change, Mac falls
into the Linux branch. Good by default.

**Hub code change**: `agentIngestWS.ts` gates auto-update to
`install_mode === 'systemd' || 'windows'`. Extend to `'macos'`:

```
if (host.install_mode !== 'systemd' && host.install_mode !== 'windows' && host.install_mode !== 'macos') return;
```

(Update: done in `agentIngestWS.ts:278,339` and in the periodic scheduler
`agentUpdateScheduler.ts:54`, which also used to skip Windows hosts, fixed
in v0.9.0.)

### 8.3 Gatekeeper and auto-update

The agent rewrites its own `.mjs` file. There is no signature to validate (it is
JS, not a Mach-O binary). Gatekeeper does not interfere with `.mjs` files
run via `node`. **No friction**.

---

## 9. Security, Gatekeeper, sudoers, sandbox

### 9.1 Gatekeeper

Since the agent is **JS run by the system `node` binary**, Gatekeeper
blocks nothing (it is `node` that is executed, and it is already allowed). If
the user installs Node from nodejs.org (.pkg), the pkg is notarized by
Apple. Brew builds locally, so it is Gatekeeper-clean.

**No ad-hoc signing needed** for `agent.mjs`.

### 9.2 TCC (Transparency, Consent and Control)

On a recent Mac (Ventura+), access to SMC sensors via `powermetrics` may
show a "powermetrics wants to monitor X" prompt. This happens ONCE,
the first time, and only if the agent runs under a LaunchAgent (user
session). Going through sudo (hence root) means no TCC prompt.

**Install note**: on the agent's first launch, the user
**may** see a system prompt. The installer must mention it explicitly
in its final output ("If you see a TCC prompt, click Allow.").

### 9.3 sudoers

See §3. The `/etc/sudoers.d/gpuviewr-agent` file must be chmod 0440
root:wheel and validated with `visudo -c -f`. The installer must refuse to write an
invalid sudoers file (otherwise no sudo command works on the machine any more,
the well-documented broken sudoers disaster).

### 9.4 Network sandbox

None. The agent opens an outbound WS. The macOS Application Firewall asks for
permission on Node's first outbound connection; if the user is not in front of
the screen (headless Mac mini), the connection may be blocked. Workaround:
the installer can run `socketfilterfw --add /usr/local/bin/node` (needs
sudo). Document it in the README, do not auto-fix (intrusive).

### 9.5 Recommendation

**v1**: do not sign with an Apple Developer ID (~$99/year + complexity), do not
try to notarize, do not touch the firewall. Clear docs in the README
that this is "self-hosted, expect 1 TCC prompt, expect to allow node in
Firewall once". **TO DECIDE 5**: confirm that the user accepts this level
of "first launch" friction.

---

## 10. PR breakdown

**PR1, Pure collector + unit tests (1-1.5 d)**: done, 2026-09-14

- `agent/src/collectors/gpuMacosPowermetrics.ts`
- `agent/src/collectors/gpuMacosPowermetrics.test.ts` with plist fixtures
  (powermetrics output captured manually on a Mac). (Update: no Mac was
  available; the fixtures are synthetic, reconstructed from public docs,
  and inlined in the test file.)
- `agent/src/collectors/macosSysctl.ts` (`hw.memsize`,
  `machdep.cpu.brand_string` helpers)
- No wiring into `index.ts` yet. The collector is isolated and testable
  on Linux CI via fixtures.

**PR2, Boot wiring + install_mode (0.5 d)**: done, 2026-09-14

- `agent/src/config.ts`: add `'apple'` to the `GpuVendor` type.
- `agent/src/index.ts`: add `'darwin'` to `resolveVendor`,
  `buildGpuCollector`, and disable the process collector.
- `agent/src/transport.ts`: add `'macos'` to `InstallMode` + detection.
- `server/database/models/Host.ts`: extend `InstallMode`.
- `server/services/agentIngestWS.ts`: allow auto-update for macOS.
- Manual smoke test: `MOCK_GPU=1 node agent.mjs` on a Mac must boot without
  crashing.

**PR3, Mac install script (1-1.5 d)**: done, 2026-09-14

- `agent/install.sh.mac.tpl`
- `server/routes/agentDistribution.ts`: new `/install.mac.sh` route.
- Manual E2E tests on a dev Mac (uninstall + install + tail logs +
  uninstall): **not done yet**, no real Mac available in that
  session. `tsc --noEmit` + `npm test` (agent) pass, but the script has
  never run on a real macOS.

**PR4, Hub UI (1 d)**: done, 2026-09-14, with a deliberate deviation on the
memory scope (see below)

- `src/lib/memoryFormat.ts` helper: done.
- 10 `src/components/...` files to touch to turn the "VRAM" label into a
  conditional: **reduced to 2** (`HostCard.tsx`, `Dashboard.tsx`); the other 8
  already used a generic, already translated label ("Memory"/"Mémoire", not
  literally "VRAM"), so zero visible change and no prop drilling
  to add for them. This matches the plan's own allowance ("not urgent
  for v1, 'Unified' can be passed as-is"). To revisit if the user
  wants the full treatment of all 10 files.
- `src/components/settings/HostsSettingsTab.tsx`: macOS recipe added.
- `src/i18n/locales/fr.json` + `en.json`: keys `type_macos*`, `macos_cmd`,
  `install_mode_macos`, `install_macos_hint` added.
- Visual browser QA (icon, "Unified" label, 4th picker tab) not
  done yet, the Chrome extension was unavailable at implementation time.

**PR5, Docs + CI sanity (0.5 d)**: docs done in v0.9.0, 2026-09-14

- Update the "macOS" section of `agent/README.md`.
- Update the root `README.md` to remove "Local GPU monitoring is
  not possible on macOS" (now possible bare-metal, still impossible in
  Docker).
- Promote `Docs/MACOS_AGENT.md` (this file) to "implemented" + log
  of deviations from the plan.
- **Optional**: `build-darwin` CI job on macos-14. (Not done.)

**Optional PR6, Processes via `--samplers tasks` (0.5-1 d)**: deferrable, out of
v1. (Update: on hold until a real capture is available, see §2.4.)

---

## 11. Testing strategy without a Mac

### 11.1 Unit tests

The existing `agent/src/collectors/gpuAmdgpuSysfs.test.ts` pattern is the
reference: it reads text **fixtures** captured once and checks the parsing
in isolation.

For macOS:

- Manually capture (on a dev Mac) 3-5 outputs of
  `powermetrics --samplers gpu_power,smc -i 1000 -n 1 --format plist`, store them
  under `agent/src/collectors/__fixtures__/powermetrics-m1.plist`,
  `powermetrics-m2max.plist`, `powermetrics-m3pro.plist`.
- Tests: feed each fixture to the parser, assert the extracted fields.
- Also cover the edge cases: a fixture without the `GPU die temperature` key (M1),
  a fixture with an `<integer>` vs `<real>` value.

(Update: no real captures exist yet. The shipped tests use synthetic
fixtures inlined in `gpuMacosPowermetrics.test.ts`, covering two plausible
key shapes and the M1 no-temperature case; there is no `__fixtures__`
directory.)

### 11.2 Boot integration tests

Mock `child_process.spawn` to simulate `powermetrics` pushing a fixture
on stdout. Check that `createMacosPowermetricsCollector` does call
`onSample` with a well-formed `GpuSample[]`.

Follow the pattern of the `agentIngestWS.test.ts` test for the WS wiring.

### 11.3 CI

The current `npm test` (`agent/package.json:15`, `tsx --test src/**/*.test.ts`)
runs on Ubuntu. Fixture-based tests pass everywhere. **No need for a
macOS runner** for PR1 and PR2. (Update, v0.9.0: the script is now
`tsx --test $(find src -name '*.test.ts')`, because the glob silently
skipped top-level test files.)

The macOS runner is only needed to validate install.sh.mac.tpl
end to end. That can be done manually at the start + after each release; it
can be left out of CI.

### 11.4 Final validation

Human side: have 1 Apple Silicon Mac (M1/M2/M3 or M4) at hand for
PR3-PR5. If none is available, second best: GitHub Actions `runs-on: macos-14` ARM
(free for public repos, $0.16/min otherwise, only exposable via a
workflow).

---

## 12. Rough estimate

| PR | Description | Estimate (person-days, fast solo dev) |
|---|---|---|
| PR1 | Collector + fixture tests | 1 to 1.5 |
| PR2 | Boot wiring, install_mode | 0.5 |
| PR3 | install.sh.mac.tpl + sudoers + LaunchAgent | 1 to 1.5 |
| PR4 | Hub UI (memory label, settings recipe) | 1 |
| PR5 | Docs + README cleanup + optional CI | 0.5 |
| **Total v1 (Apple Silicon, no processes)** | | **~4 to 5 person-days** |
| PR6 (optional) | processes via `--samplers tasks` | +0.5 to 1 |

Risks likely to inflate the estimate:

- Robust plist parser (if a third-party dep is refused): +0.5 d on PR1.
- TCC or sudoers bug discovered on a real Mac: +0.5 d on PR3.
- Refactor of the frontend store to propagate `install_mode` to the memory
  components: +0.5 d on PR4.

Realistic floor: **4 d**. Ceiling: **6 d**.

---

## "TO DECIDE" items raised

1. **Scope**: darwin-arm64 only vs darwin-arm64 + darwin-x64. Rec: arm64
   only.
2. **Privileges**: root LaunchDaemon vs LaunchAgent + sudoers NOPASSWD. Rec:
   targeted sudoers.
3. **Distribution**: stay on a single `agent.mjs` bundle vs a signed binary.
   Rec: bundle.
4. **Unified memory mapping**: Option A (memory pressure via vm_stat) vs B
   (null) vs C (ioreg). Rec: A, with a clear UI.
5. **"First launch" friction**: accept the TCC prompt + macOS Firewall on the
   first run, or try to script around them? Rec: document, do not script.
6. **macOS CI runner**: add a macos-14 job or not? Rec: not in v1.
7. **Mac processes**: defer to PR6 or skip for good? Rec: defer.

---

## Critical files for the implementation

- `agent/src/index.ts`
- `agent/src/collectors/gpuWindowsPdh.ts` (reference pattern for the
  long-running spawn)
- `agent/install.sh.tpl` (Linux installer pattern to transpose)
- `agent/install.ps1.tpl` (re-install lifecycle pattern to transpose)
- `server/services/agentIngestWS.ts` (auto-update gates to extend)
