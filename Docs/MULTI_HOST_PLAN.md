# Architecture plan: GpuViewR Multi-Machine Viewer

> **Status: implemented in v0.3.0, kept as the design rationale.**
>
> This is the original plan behind the multi-host architecture shipped in v0.3.0. It remains the reference for decisions D1-D9, the DB schema, the auth model and the WS contract (code comments cite it, e.g. D4 in `alertService.ts`, §3 and §13.1.1 in `agentIngestWS.ts`). Later changes that supersede parts of it (see `CHANGELOG.md`):
>
> - **v0.3.1 / v0.4.0**: AMD / ROCm support, first in the agent (`GPU_VENDOR=auto|nvidia|amd`, v0.3.1), then in the hub (v0.4.0). The plan assumed NVIDIA only.
> - **v0.5.0**: the hub is vendor-neutral. The hub-local GPU collectors are removed; local GPUs are reported by a sidecar agent authenticated with `LOCAL_AGENT_BOOTSTRAP` (`HOST_ID=local`). One agent can also push to several hubs (`HUB_URLS` / `HOST_IDS` / `AGENT_TOKENS`).
> - **v0.5.3**: opt-in agent auto-update over the WS (`agent_update` frame, `hosts.auto_update` toggle), first for systemd agents, later Windows (v0.6.7) and macOS (v0.9.0).
> - **v0.6.7**: native Windows agent (`install.ps1`, Scheduled Task); AMD / Intel on Windows via PDH counters in v0.7.0.
> - **v0.9.0**: macOS agent (Apple Silicon, `powermetrics`).
> - Bare-metal agents ship as an `agent.mjs` bundle run by Node 22 and installed by the hub-served `install.sh` (since v0.3.0), not as a Node SEA binary.
> - **v0.10.2 / v0.10.3**: the systemd unit grants `CAP_SYS_PTRACE` (seccomp-filtered) for the AMD process list; `install.sh --upgrade` refreshes an install without a token.
> - **v0.11.0**: Intel GPUs, LLM server APIs, process alerts and history, hub-pushed `config` frame (Settings > LLM).
>
> File references below name files only: the line numbers of the original plan pointed at v0.2.5 / v0.3.0 code and have drifted, search by symbol.
>
> ---
>
> Purpose (at the time): move GpuViewR (v0.2.5, single host) to a mode where **a central dashboard aggregates GPU/system metrics from N NVIDIA hosts**, without breaking the existing zero-config deployment. Target: v0.3.x.
>
> Out of scope (by choice): any multi-host UI rendering, per-host visual dashboards, multi-organization RBAC, SQLite sharding, transactional cross-host alerting. This note covers the backbone and the API/transport contract.

## Decisions taken (before implementation)

| # | Topic | Decision | See |
|---|---|---|---|
| D1 | Transport approach | Agent pushes over an outbound WebSocket | §1 |
| D2 | Agent location | `/agent` sub-package in the same repo, TypeScript Node 22 | §5 |
| D3 | Prometheus label | `host="<id>"` (stable UUID) **+** side metric `gpuviewr_host_info{host=<id>, label=<name>, hostname=<os>} 1` for the Grafana join | §7, §10 |
| D4 | Alert rule scope | `alert_rules.host_id NULL` = global (wildcard), like `gpu_index NULL`. `host_id='<id>'` = targeted | §10 |
| D5 | Agent buffer | RAM only by default (ring of 3,600 entries). Disk persistence via opt-in `AGENT_BUFFER_PERSIST=1` | §4, §9 |
| D6 | TLS | Delegated to the reverse proxy (`wss://`). No mTLS or cert pinning in v0.3 | §3 |
| D7 | Agent token | Opaque random 32+ bytes, bcrypt-hashed on the hub. **Not** a JWT. Auth space disjoint from `JWT_SECRET` | §3 |
| D8 | Host identity | Stable UUIDv4 (`host.id`), reported hostname is informational only | §2, §10 |
| D9 | Front-end WS stream | A single multiplexed stream with `host_id` in the envelope. Optional `?hosts=A,B` filtering | §6 |

---

## 1. Trade-offs between the viable approaches, explicit recommendation

| # | Approach | Network required | User install | Offline robustness | Maintenance | Fit with existing code |
|---|---|---|---|---|---|---|
| **(a)** | **Agent push WS**: lightweight binary/container on each host, opens an outbound WS to the hub | **Outbound only** (NAT-friendly) | 1 container or 1 systemd service + 1 URL + 1 token | Local buffer on the agent, replay on reconnect | Low: one binary, one protocol | **Very strong**: mirrors the internal `gpuStreamWS.ts` |
| (b) | Hub pull (HTTP `/metrics` or SSH `nvidia-smi`) | Port to open on the node (or shared SSH key) | Heavier: expose a port + ACL or SSH key | Hub must handle the timeout, no buffer on the node | Medium: network config falls on the user | Weak: reverses the data flow |
| (c) | Peer federation (each host = full GpuViewR) | Bidirectional, HTTP+WS ports | Very heavy: SQLite + frontend + auth on every node | Very good locally, redundant | **Heavy**: N stacks to update | Medium, but every node pays for a full dashboard for nothing |
| (d) | DCGM exporter + Prometheus + GpuViewR scrapes Prom | DCGM + Prometheus ports | Must already have Prom in the infra | Excellent (Prom handles it) | Delegates to the Prom ecosystem, but **loses the product identity** | Weak: GpuViewR becomes a skin over Prom |

### Recommendation: **(a) Agent push WebSocket**

Deciding reasons:

1. **Architectural consistency**: `gpuCollector` already emits through an `EventEmitter`, and `gpuStreamWS` only routes that flow to clients. An agent that produces the same `GpuSample` type and connects to the hub over WS literally reuses the existing pipeline. The hub change boils down to "inject into the event bus as if it were a local collector".
2. **Minimal user friction**: no port to open on the node, which is crucial in home labs and university labs behind NAT. A `docker run` or a `systemctl start` is enough.
3. **Robustness to offline nodes**: the agent can buffer in RAM (or on disk for long outages) and replay on reconnect. This is simpler to implement in this direction than one where the hub would have to guess that the node exists.
4. **Solo open source**: one protocol, one binary to package, no service discovery, no DNS, no mandatory mTLS. The value/maintenance ratio is unbeatable.

Pragmatic note: for users who already run Prometheus, **mode (d) can be kept as an optional "byo-telemetry" path** later (a host of kind `prometheus` that scrapes a Prom endpoint instead of having a WS agent). It is **not** in the v0.3.0 scope, but the DB schema must allow it through a `kind` column on the `hosts` table.

Approaches (b) and (c) are rejected: (b) reverses network control in the wrong direction, (c) multiplies the attack surface and the update debt.

---

## 2. DB schema impact

### New `hosts` table

```
hosts (
  id            TEXT PRIMARY KEY,        -- UUIDv4 generated at enrollment
  label         TEXT NOT NULL,           -- human name ("rtx-rig", "lab-3")
  hostname      TEXT,                    -- os.hostname() reported by the agent
  kind          TEXT NOT NULL,           -- 'local' | 'agent' | 'prometheus' (reserved)
  endpoint      TEXT,                    -- for kind='prometheus' later
  token_hash    TEXT NOT NULL,           -- bcrypt of the enrollment secret
  capabilities  TEXT,                    -- JSON: { gpu:true, system:true, processes:true, temps:true }
  agent_version TEXT,
  protocol_ver  INTEGER NOT NULL DEFAULT 1,
  enrolled_at   INTEGER NOT NULL,
  last_seen     INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending'   -- 'pending' | 'online' | 'offline' | 'disabled'
)
```

`id` is a **stable UUID** (not the hostname), generated at `POST /api/hosts/enroll` time. The hostname can change (box renamed, container recreated) without breaking historical correlation. This is crucial (see §10).

### Changes to existing tables: adding `host_id`

All metric models carry a `host_id TEXT NOT NULL`:

- `gpu_metrics`: `host_id TEXT NOT NULL DEFAULT 'local'`
- `gpu_devices`: the PK changes from `(gpu_index)` to `(host_id, gpu_index)`; `uuid` stays secondary (two hosts can have distinct NVIDIA UUIDs at the same index position)
- `alert_events`: `host_id TEXT NOT NULL DEFAULT 'local'`, the event belongs to a host
- `alert_rules`: `host_id TEXT NULL`, `NULL` = global rule applying to all hosts, `'<id>'` = targeted

### Files involved

- `server/database/connection.ts` (lines 35-73): initial DDL + migration block. Follow the existing pattern already used for the `utilization NOT NULL` migration (l.78-111): detect the `host_id` column via `PRAGMA table_info('gpu_metrics')`, and run the `CREATE NEW / INSERT … 'local' / DROP / RENAME` migration inside a transaction. Recreate the indexes with a `host_id` prefix: `idx_gpu_metrics_host_gpu_epoch ON gpu_metrics(host_id, gpu_index, timestamp_epoch)`.
- `server/database/models/GpuMetric.ts`: every method (`insert`, `insertMany`, `history`, `historyDownsampled`, `historyIterate`, `stats`, `pruneOlderThan`) takes a `host_id` as first argument. **Compat**: keep a legacy `(gpu_index, …)` signature that pre-fills `'local'` so the single-host hub does not break during the internal migration.
- `server/database/models/Alert.ts`: `gpu_index INTEGER NOT NULL` stays, `host_id` is added to `AlertEvent` and optionally to `AlertRule`. The state map key in `alertService.ts` (`${rule.id}:${sample.gpu_index}`) becomes `${rule.id}:${host_id}:${gpu_index}`.
- **New**: `server/database/models/Host.ts`: CRUD repo + helpers `markSeen(id)`, `setStatus(id, status)`, `findByTokenHash(hash)`.

### Migrating existing data

On the first v0.3.x boot on a v0.2.5 database:

1. Detect that the `hosts` table is missing → this is a legacy install.
2. `INSERT INTO hosts (id, label, kind, …) VALUES ('local', 'local', 'local', …, 'online')`.
3. Migrate `gpu_metrics`/`gpu_devices`/`alert_events` by adding `host_id='local'` to every existing row (idempotent, no loss).
4. The internal `gpuCollector` keeps writing with `host_id='local'` (see §6).

The end user does **nothing**: the install updates itself, historical charts are preserved, and the "Add host" button simply becomes available.

---

## 3. Auth and security between nodes

### Per-host token model

No global shared JWT. Each agent has its own **enrollment token** (long, ≥ 32 random bytes), stored **bcrypt-hashed** on the hub (reuse `authService.hashPassword` / `verifyPassword`, see `authService.ts`). The clear token only exists:

- with the user at enrollment time (shown once in the UI / API response),
- in the agent config (`AGENT_TOKEN=…` as an env var).

On the agent side, the token is sent either as an `Authorization: Bearer <token>` header during the WS handshake, or as a `?token=…` query string (as `gpuStreamWS.ts` already does).

### Enrollment workflow

1. **Admin** on the hub: `POST /api/hosts` `{ label }` → generates a UUID `id` + raw token → returns `{ id, token }` only once.
2. The admin copies/pastes the displayed command:
   ```
   docker run -e HUB_URL=wss://hub/agent -e AGENT_TOKEN=… -e HOST_ID=… ghcr.io/erreur32/gpuviewr-agent
   ```
3. The agent connects to the hub. The hub checks `bcrypt.compare(token, host.token_hash)` AND `host.id === message.host_id` (a token can only prove the identity of **a single** host).
4. The first valid frame switches `status` to `online`, updates `last_seen`, and writes the `agent_version` and `protocol_ver` reported by the agent.

### Rotation

- `POST /api/hosts/:id/rotate-token`: invalidates the old hash, generates a new one, returns it once. The agent must be reconfigured (equivalent to a re-enrollment, simple).
- No automatic rotation in v0.3.x: too much complexity for the benefit. To plan post-1.0.

### TLS

- **Recommendation**: do **not** reimplement TLS in Node. Delegate to the reverse proxy (nginx/Caddy/Traefik) the user already runs in front of `PUBLIC_URL`. The agent connects with `wss://`. Cert pinning: rejected for v0.3, too many rough edges (cert rotation, Let's Encrypt 90 days, etc.) for a solo project. Document in `SECURITY.md` that the hub **must** be behind TLS in multi-host production.
- In dev/local without TLS: `ws://` is allowed if the hub listens on loopback or a private network. Explicitly refuse `ws://` to a public IP through a config check (whitelist localhost/private CIDR, otherwise `nodeEnv === 'production'` → error).

### Isolation: preventing a compromised agent from polluting another host

Invariant rule at the hub level: **any `host_id` in an incoming frame is ignored; the hub uses the one authenticated by the token at handshake**. Concretely, the agent can send `{ type: 'sample', samples: […] }`. It does **not** declare `host_id` in the frame; the hub tags it server-side from the WS session. This defeats the "I compromised host A's agent, I publish under host B's host_id" attack.

### Relation to the existing `JWT_SECRET`

`JWT_SECRET` (see `config.ts`) remains **strictly for UI user sessions**. Agent tokens are **opaque** (random 32+ bytes, not signed JWTs). Reason: no claims are needed (one token = one host_id, already resolved in the DB), and it avoids the "who can sign for whom" confusion if `JWT_SECRET` ever leaks. Two strictly disjoint auth spaces are simpler to reason about.

(Later additions: since v0.5.0 the local sidecar authenticates with the `LOCAL_AGENT_BOOTSTRAP` shared secret instead of a bcrypt token, see §10. Since v0.6.4 the token handed to the user is the `<host_id>.<secret>` bundle; only the secret half is bcrypt-hashed.)

---

## 4. Transport

### Recommended protocol: **persistent WebSocket agent → hub**

No surprise given the internal architecture: maximum reuse.

### Payload format (proposed, v1)

Frames sent by the agent (all JSON, one frame = one object):

```
// 1. Handshake (first message after connecting)
{ "type":"hello", "host_id":"<uuid>", "agent_version":"0.3.0",
  "protocol_ver":1, "hostname":"rtx-rig", "capabilities":{ "gpu":true,"system":true,"temps":true,"processes":false } }

// 2. Periodic sample (GPU tick = 1s by default)
{ "type":"sample", "ts_epoch":1731600000, "samples":[ <GpuSample without host_id> … ] }

// 3. Host snapshot (CPU/mem/load), less frequent, e.g. every 5s
{ "type":"system", "ts_epoch":…, "stats": <SystemStats> }

// 4. hwmon temperatures
{ "type":"temps", "ts_epoch":…, "sensors":[…] }

// 5. Processes (on demand or periodic depending on config)
{ "type":"processes", "ts_epoch":…, "processes":[…] }

// 6. Keep-alive
{ "type":"ping", "ts_epoch":… }
```

Hub → agent frames:

```
{ "type":"welcome", "hub_version":"0.3.0", "protocol_ver":1, "tick_ms":1000 }
{ "type":"config", "patch":{ "tick_ms":2000 } }   // lets the hub adjust the cadence
{ "type":"pong", "ts_epoch":… }
```

(Later addition: v0.5.3 added the hub → agent `agent_update` frame for auto-update, see §12.3.)

### Reuse `GpuSample`?

**Yes**, it is the pivot type. The hub re-publishes to UI clients the same `{ type:'sample', samples:[…], host_id }`, just adding `host_id` at the envelope level (see §6). No type duplication, and the frontend only gains a `host_id` field to dispatch on.

### Reconnection, backpressure, time skew

- **Reconnection**: bounded exponential backoff on the agent (1s → 2 → 4 … capped at 30s, jitter ±20%). On reconnect, replay the local buffer (see below), then normal flow.
- **Backpressure**: if `ws.bufferedAmount > N` (e.g. 1 MiB), the agent switches to "degraded" mode: it drops `processes`/`temps` frames but keeps GPU `sample` frames (the most valuable data). Log warn.
- **Time skew**: every frame carries a `ts_epoch` from the **agent's** clock. The hub stores **two** epochs: `agent_ts_epoch` (reported) and `hub_ts_epoch` (received). For queries/charts the hub uses `hub_ts_epoch` (multi-host flow consistency); `agent_ts_epoch` is kept for diagnostics. Recommend NTP in the docs, but do not enforce it.
- **Local agent buffering while the hub is down (D5)**: RAM ring buffer (bounded at 3,600 entries ≈ 1 h × 1 Hz, ~1.7 MiB for 4 GPUs), **default mode**. Disk persistence in `$DATA_DIR/agent-buffer.jsonl` enabled only through `AGENT_BUFFER_PERSIST=1` (opt-in for users with an unstable hub). The buffer is **append-only**, drained FIFO on reconnect. Past the limit, the oldest entries are dropped: a 1 h old metric is worth less than a fresh one.

### Protocol versioning

`protocol_ver: 1` field in `hello` and `welcome`. The hub must accept `protocol_ver <= MAX_KNOWN`; a newer agent downgrades cleanly. Any breaking change → bump to 2, the hub keeps supporting 1 for at least two minor versions.

---

## 5. Code layout: where does the agent live?

### Recommendation: **`agent/` sub-package in the same repo**, in TypeScript Node 22

Radical and explicit choice: **no monorepo**, just an `/agent` folder next to `/server` and `/src`, with its own minimal `package.json`, its `Dockerfile.agent`, and a selective import from `/server` for the types and the nvidia-smi parsing.

### Rationale

1. **Solo-maintainer consistency**: one repo = one release cycle, one `CHANGELOG.md`, one CI flow. The hub/agent protocol evolves in lockstep, with no version desync.
2. **Direct reuse of the nvidia-smi parsing**: the code in `gpuCollector.ts` (CSV parser, PCIe parser, normalization) **is** the project's added value. Rewriting it in Go or Python would duplicate the parsing debt (which has already absorbed several fix commits, see the `pcieDiagLogged` comments, the `idx:N` fallback, etc.). Extract a shared `agent/lib/nvidiaParsers.ts` sub-module.
3. **Node footprint**: yes, Node takes ~80 MiB RSS, but that is acceptable even on modern bare-metal nodes; and the agent needs neither `better-sqlite3` nor `express` nor `react`, just `ws` and the runtime, so `node_modules` < 10 MiB.
4. **Packaging**: **alpine** or **distroless** Docker image (~50 MiB compressed, without the UI dist); and for bare-metal machines that do not want Docker, `node --experimental-sea-config` (native Node 22 Single Executable Application) produces a static ~50 MiB binary. Document both. (Superseded in v0.3.0: bare-metal ships as the esbuild `agent.mjs` bundle run by Node 22 via `install.sh`, no SEA binary. The agent image moved from distroless to `node:22-*-slim` in v0.3.1.)

### Why not Go or Python?

- **Go**: 5 MiB binary, appealing, but we lose reuse of the TypeScript parser, and we would have to maintain two implementations of the nvidia-smi CSV parsing → bug surface × 2.
- **Python**: runtime to package (~30 MiB compressed via PyInstaller), parsing to redo, zero gain.

### Target tree

```
/agent
  package.json              # depends on "ws" only (+ types from ../server)
  Dockerfile
  src/
    index.ts                # bootstrap + lifecycle
    config.ts               # HUB_URL, HOST_ID, AGENT_TOKEN, TICK_MS, FEATURES
    transport.ts            # WebSocket client, reconnect, buffer
    collectors/
      gpu.ts                # imports ../../server/services/_nvidiaParsers (factored out)
      system.ts             # lightweight version of systemStats.ts
      temps.ts              # lightweight version of systemTemperatures.ts
      processes.ts          # lightweight version of processCollector.ts
  README.md
```

Server-side factoring (to do in a preparatory commit, see §9 milestone 1):

- Extract from `server/services/gpuCollector.ts`:
  - `parsePciThroughput`, `normalizeBusId`, `matchKbps`, `QUERY_FIELDS`, the `GpuSample` type → neutral file `server/services/_nvidiaParsers.ts` (importable from the agent **and** from gpuCollector).
- Same for `server/services/systemStats.ts` (already self-contained, just needs to be exposed publicly) and `systemTemperatures.ts` (same).

---

## 6. Central hub: adapting without breaking single-host

### Principle: `gpuCollector` stays one provider **among others**

Today `gpuCollector` is a singleton that spawns nvidia-smi locally and emits `'sample'`. Tomorrow we introduce a **level of indirection**: a `MetricsBus` (single event bus on the hub) fed by **all** producers. Three possible producers:

1. **Local collector** (the current `gpuCollector`), tagged `host_id='local'`. Enabled if and only if `nvidia-smi` is available (already handled by `nvidiaSmiAvailable`, l.105). If there is no local nvidia-smi, the hub produces nothing itself and only aggregates. (Superseded in v0.5.0: the hub-local collectors were removed. Local GPUs are now reported by a sidecar agent in the same compose stack, authenticated with `LOCAL_AGENT_BOOTSTRAP` and `HOST_ID=local`, through the same `/agent` ingest as remote agents.)
2. **Agent ingestor** (new): accepts incoming WS on `/agent` (and **only** for hosts enrolled with a valid token). For each `sample` frame received, tags it with the `host_id` from the session and re-emits it on the `MetricsBus`.
3. (Reserved) **Prometheus scraper**: future.

### Concrete patch

- `server/services/metricsBus.ts` (new): a typed `EventEmitter` exposing `emit('sample', { host_id, samples })`, `emit('system', …)`, etc. All current `gpuCollector` subscribers move to this bus.
- `server/services/gpuCollector.ts`: the `this.emit('sample', samples)` (l.140, 301) becomes `metricsBus.emit('sample', { host_id: 'local', samples })`. The file's public signature does not change as long as we are pure single-host.
- `server/services/agentIngestWS.ts` (new): symmetric to `gpuStreamWS.ts`, but server-side. Mounted on path `/agent`. Auth = agent token check (not user JWT). Each received message is dispatched on `metricsBus`.
- `server/services/gpuStreamWS.ts`: `gpuCollector.on('sample', …)` (l.30) becomes `metricsBus.on('sample', ({ host_id, samples }) => safeSend(ws, { type:'sample', host_id, samples }))`.
- The initial `snapshot` sent to the client (l.23-24) must become multi-host too: iterate over the last known samples of each host. Maintain a `Map<host_id, GpuSample[]>` updated on every tick, accessible via `metricsBus.getLatestPerHost()`.
- `server/index.ts`: call `setupAgentIngestWS(server)` next to `setupGpuWebSocket(server)`. Start `gpuCollector.start()` **only if** nvidia-smi is available (the code is already there).

### Zero-config behavior unchanged

A fresh install on a machine with nvidia-smi:
- `host_id='local'` created automatically at boot (see §2 migration).
- `gpuCollector` starts and publishes.
- The UI client receives `{ type:'sample', host_id:'local', samples:[…] }`. It can simply ignore `host_id` or group by "local" → the v0.2.5 UI keeps working without touching the front end (apart from tolerant parsing of the new field).

### Multiplexed stream vs one stream per host

**Recommendation: a single multiplexed front-end WS stream**, with `host_id` in every envelope. A UI client often needs **all** hosts at once (global dashboard), and multiplying WS connections in the browser multiplies the bug surface for zero perf gain at the targeted scale (up to ~20-50 hosts).

Filtering: the client can request `/ws/gpu?hosts=A,B` at handshake to receive only a subset (saves mobile bandwidth). The hub checks authorization and filters.

---

## 7. Front-end API surface (REST + WS)

### New routes: file `server/routes/hosts.ts` (new)

```
GET    /api/hosts                       → list (id, label, status, last_seen, agent_version, capabilities)
POST   /api/hosts                       → admin: enroll → returns { id, token } once
GET    /api/hosts/:id                   → full details
PATCH  /api/hosts/:id                   → admin: rename label, disable, …
DELETE /api/hosts/:id                   → admin: removes the enrollment, optional metrics purge
POST   /api/hosts/:id/rotate-token      → admin: new opaque value
GET    /api/hosts/:id/status            → quick health (online/lag/last_seen seconds)
```

### Existing routes to extend

- `server/routes/gpu.ts`:
  - `GET /api/gpu/devices` (l.10) → accept `?host=<id>`, default "all". Response `{ devices: [ { host_id, gpu_index, name, … }, … ] }`.
  - `GET /api/gpu/current` (l.14) → same.
  - `GET /api/gpu/history` (l.24) → mandatory `host` param, otherwise 400 error (the user must choose; N-host aggregation on one chart makes little sense for v1).
  - `GET /api/gpu/history.csv` (l.44) → accept `host=<id>` or `host=all` (see the `gpu=all` convention already in place at l.45).
  - `GET /api/gpu/stats` (l.79) → same.
- `server/routes/system.ts`:
  - `GET /api/system/` (l.88) → either stays on the local host by default, or accepts `?host=<id>`. The `host` field in the response becomes a list if there is no filter.
- `server/routes/processes.ts`:
  - `GET /api/processes/` → accept `?host=<id>`. If the host's agent does not have `capabilities.processes`, return `{ processes: [], reason: 'not-supported' }` rather than 404.
- `server/routes/alerts.ts`:
  - Listed events now carry `host_id`, so the front end can group them. No other strict change (see §10 for the global vs per-host rules decision).
- `server/routes/metrics.ts` (Prometheus), **decision D3**:
  - Add the `host="<id>"` label (stable UUID) to every `gpuviewr_*` series.
  - **Additionally** emit a side series `gpuviewr_host_info{host="<id>", label="<name>", hostname="<os>"} 1` (idiomatic pattern, see `node_uname_info`). Grafana joins via `* on (host) group_left (label) gpuviewr_host_info`.
  - Benefit: renaming a host in GpuViewR does **not** break the user's Grafana queries (the ID is stable).
  - Important: this **breaks** existing single-host Prom dashboards (which had no `host` label); document it in the CHANGELOG.
- `server/routes/health.ts`:
  - Add `hostsTotal`, `hostsOnline`, `hostsLagging` (last_seen > 30s).

### Front-end WebSocket

- `/ws/gpu` stays, the format evolves: every `sample` message carries `host_id`. Same for `alert`. Add a new `host_status` type `{ host_id, status:'online'|'offline'|'lagging', last_seen }` emitted when the hub detects a change (see §10 on offline detection).
- Optional `?hosts=A,B` query string for filtering.

### Out of scope

- No dedicated `/ws/hosts` WebSocket: overkill, the `host_status` channel on `/ws/gpu` is enough.
- No auto-discovery API (mDNS, etc.). The user enrolls manually, which is explicit and auditable.

---

## 8. Compat and migration v0.2.5 → v0.3.x

### Zero-touch strategy for single-host users

1. Boot v0.3.0 on a v0.2.5 DB → automatic migration (§2) that creates `hosts` + fills `host_id='local'`.
2. `nvidia-smi` detected → the local collector starts as before. (Superseded in v0.5.0: the local sidecar agent replaces the hub-local collector, see §6.)
3. The v0.3.0 frontend shows a "Hosts (1)" panel collapsed by default on "local" → the user sees no major change.
4. "Add host" button visible in Settings (admin only): the only visible novelty as long as nobody enrolls.

### Hub ↔ agent versioning

- **Hub**: follows the `package.json` semver (already in place: 0.2.5 → 0.3.0).
- **Agent**: same version as the hub within the same repo (one git tag → two images: `ghcr.io/erreur32/gpuviewr:0.3.0` and `…/gpuviewr-agent:0.3.0`).
- **Protocol**: `protocol_ver` field separate from the application semver. Starts at 1. A MAJOR hub (0.4 → 0.5) may bump to 2; it keeps supporting v1 for agents not yet upgraded for one cycle. A `welcome` frame can return `{ deprecated:'protocol_ver=1', migrate_by:'0.5.0' }` as a warning.

### Migrating external dashboards (Prometheus, MQTT, Influx)

- Prometheus: new `host=` label. Migration document in `Docs/MIGRATION.md` with a PromQL aggregation snippet (`sum by (gpu) (gpuviewr_gpu_power_watts)`) to preserve existing dashboards on `host="local"`.
- MQTT: add a topic level `gpuviewr/<host>/gpu<N>/state` (default prefix `gpuviewr/local/gpu0/state` to stay backward compatible on 1 host). But a multi-host user **must** update their HA Discovery templates. To document.
- InfluxDB: add a `host=<label>` tag to the lines. The existing `gpu_index` tag stays.

### Degraded cases to handle

- v0.2.5 DB without `gpu_metrics` (fresh install): no migration needed, just create the v0.3.x schema.
- Partially migrated DB (process crash midway): the migration is transactional (`BEGIN; … COMMIT;`) like the existing example at l.85. `connection.ts` must only retry if `hosts` does not exist, or detect an interrupted migration (orphan `gpu_metrics_new` present → DROP).

---

## 9. Split into deliverable milestones

5 milestones. Each = 1 reasonable PR, mergeable and testable on its own. No UI milestone.

### Milestone 1: preparatory refactor (functional no-op)

Goal: move the nvidia-smi and system helpers out of the service modules so the agent can reuse them. No feature, no behavior change.

- Create `server/services/_nvidiaParsers.ts`: move `QUERY_FIELDS`, `parsePciThroughput`, `normalizeBusId`, `matchKbps`, `num`, `numOrNull`, `nowTimestamp`, and the `GpuSample` type. `gpuCollector.ts` re-imports them.
- Create `server/services/_metricsBus.ts`: new singleton `EventEmitter`. Wire `gpuCollector.emit('sample', …)` onto it with a hardcoded `host_id='local'`. `gpuStreamWS.ts`, `alertService.ts`, `exportService.ts` move their `gpuCollector.on('sample', …)` to `metricsBus.on('sample', ({ host_id, samples }) => …)`. In this milestone `host_id` is always `'local'`.
- Test: everything must work exactly as before; add a `metricsBus.test.ts` unit test.

Files: `server/services/gpuCollector.ts`, new `_nvidiaParsers.ts` + `_metricsBus.ts`, `gpuStreamWS.ts`, `alertService.ts`, `exportService.ts`.

### Milestone 2: multi-host DB schema + migration

- Create `server/database/models/Host.ts` (CRUD + helpers `markSeen`, `setStatus`).
- Extend `server/database/connection.ts`:
  - `CREATE TABLE hosts` DDL.
  - Migration block for `gpu_metrics`/`gpu_devices`/`alert_events` that adds `host_id` with value `'local'` for existing rows.
  - Recreate the indexes with a `host_id` prefix.
  - Insert the `hosts ('local', 'local', 'local', …, 'online')` row.
- Adapt every method of `GpuMetric.ts` and `Alert.ts` to `host_id`; for this PR, application code passes `'local'` everywhere (still functional single-host).
- Check via a test that the migration on a v0.2.5 DB yields the same `gpu_metrics.count()` as before and that the rows have `host_id='local'`.

Files: `server/database/connection.ts`, `server/database/models/GpuMetric.ts`, `server/database/models/Alert.ts`, **new** `server/database/models/Host.ts`.

### Milestone 3: `/api/hosts` API + agent WS ingest

- `server/routes/hosts.ts` (new): CRUD + enrollment + rotate-token. `requireAdmin` everywhere except `GET /api/hosts/:id/status` (just `requireAuth`).
- `server/services/agentIngestWS.ts` (new): WS on `/agent`. Authentication via the token in the query string + `Host.findByTokenHash` lookup + `bcrypt.compare`. On a `hello` frame, check the message's `host_id` against the session's `host_id`. On `sample`/`system`/`temps`/`processes` frames, re-emit on `metricsBus` tagged with the session's `host_id`. Update `last_seen` on every frame (with a 1 s throttle so as not to hammer the DB).
- Watchdog: ticks every 5 s, marks `status='offline'` the hosts whose `last_seen < now - 30s`. Emits a `host_status_changed` event on `metricsBus` that `gpuStreamWS` forwards to clients.
- Test: local bidirectional connection (a fake WS client presenting itself as an agent and publishing a `sample` frame) → check that `metricsBus` receives the tagged sample.

Files: new `server/routes/hosts.ts`, `server/services/agentIngestWS.ts`; change `server/index.ts` (lines 23-33 for the mount, 117 for the WS bootstrap).

### Milestone 4: packaged standalone agent

- Create `/agent` with a minimal `package.json` (`ws` + `tsx`), a `tsconfig.json` pointing to `../server/services/_nvidiaParsers.ts` through path mapping.
- `agent/src/index.ts`: env config (`HUB_URL`, `HOST_ID`, `AGENT_TOKEN`, `TICK_MS`, `FEATURES=gpu,system,temps,processes`), start the configured collectors, WS transport.
- `agent/src/transport.ts`: exponential reconnect, in-memory ring buffer of 3,600 entries max (see D5), replay on reconnect, `hello`/`welcome` handshake. If `AGENT_BUFFER_PERSIST=1`, append-only mirror in `$DATA_DIR/agent-buffer.jsonl` with rotation at 10 MiB.
- `agent/Dockerfile`: multi-stage, runtime on `node:22-alpine` or `gcr.io/distroless/nodejs22-debian12`, target size < 60 MiB compressed.
- As a bonus, document the `node --experimental-sea-config` command to produce a static bare-metal binary.
- Extend `docker-compose.yml` with a separate example file `docker-compose.agent.yml` (the user drops it **on the remote node**, not on the hub).

Files: new `/agent/**` folder, new `docker-compose.agent.yml`, update `README.md` with an "Add a remote host" section.

### Milestone 5: front-end API + Prometheus + exports

- `server/routes/gpu.ts`, `system.ts`, `processes.ts`: accept `?host=<id>` (see §7).
- `server/routes/metrics.ts` and `server/services/exportService.ts`: add the `host=` label to Prometheus, the `host=` tag to InfluxDB, and a `<host>/` topic level to MQTT. Compat: if there is a single host (`local`), keep the old format so as not to break single-host users' dashboards.
- `server/services/alertService.ts`: the state key becomes `${rule.id}:${host_id}:${gpu_index}`. Inserted events carry `host_id`.
- `server/routes/health.ts`: add `hostsTotal`, `hostsOnline`.
- `Docs/MIGRATION.md`: v0.2.5 → v0.3.0 how-to + new Prom/MQTT/Influx formats.

Files: `server/routes/gpu.ts`, `system.ts`, `processes.ts`, `metrics.ts`, `health.ts`, `alerts.ts`, `server/services/exportService.ts`, `server/services/alertService.ts`, `Docs/MIGRATION.md`, `CHANGELOG.md`.

At the end of milestone 5 we have a **working multi-host instance**: the single-host hub works as before, an admin can enroll an agent in 30 seconds, and every surface (API, exports, alerts) is host-aware. The UI can follow in a v0.3.1.

---

## 10. Risks and pitfalls

### Infinite loop if a GpuViewR points to itself

A real risk if someone mixes up `agent` and `hub` and configures an agent whose `HUB_URL` points to itself. **Guard**: at handshake, the agent logs the `host_id` it sends; on the hub side, refuse a `host_id` that matches the local host (see §2: `hosts` always contains a `'local'` row). Explicit error "host_id collides with local host". Not a true loop (messages go up and are then ignored), but it avoids confusion. (Superseded in v0.5.0: `local` is now claimed by the sidecar agent, accepted only with the `LOCAL_AGENT_BOOTSTRAP` shared secret; a regular enrolled token still cannot claim `local`.)

### Hostname change

`os.hostname()` can change (rename, Docker rebuild). That is why `host.id` is a **stable UUID**, not the hostname. The `hostname` reported by the agent is only **informational** (shown in the UI, updated on every `hello`). All historical correlation in the DB is done on `host_id`.

### Alert consistency: global or per host?

**Decision taken (D4)**: `alert_rules.host_id NULL` = global rule (applies to all hosts, just as `gpu_index NULL` = all GPUs today), `host_id='<id>'` = targeted rule. Events always record the `host_id` that triggered them. The hysteresis state in `alertService.ts` is keyed by `(rule_id, host_id, gpu_index)`, so a global rule can fire independently on host A and host B (which is what we want). Full symmetry with the existing `gpu_index` pattern. Document explicitly in `Docs/MIGRATION.md`.

### Exports (Prometheus/MQTT/Influx/Webhook)

- Prom: new `host=` label ⇒ Grafana **breaking change**. Announce it loudly in the CHANGELOG.
- MQTT: new `gpuviewr/<host>/…` prefix. Same.
- Webhooks (Discord/Telegram): the `formatAlert` signature must inject the host label in the title. Otherwise a user receives "GPU #0 temperature firing" without knowing which of their 5 machines is complaining.

### Agent spamming the hub

A buggy or compromised agent could send 10k samples/s. **Guard**: rate limit at the WS session level, e.g. `100 messages/s` max through a sliding window. Beyond that, log warn + forced disconnect + reconnect cooldown.

### Massive time skew (NTP disabled)

If the agent is 10 min behind, its `sample.ts_epoch` values pollute the charts. Decision: the hub stores `hub_ts_epoch` as the authoritative `timestamp_epoch` (see §4). The skew diagnostic is exposed via `GET /api/hosts/:id/status` (`time_skew_seconds`).

### Agent ↔ hub schema drift

If the agent sends a `GpuSample` with an unknown field (because it is ahead of the hub), the hub must silently **ignore** it (forward compat). Conversely, if a field the hub expects is missing, the field is `null`. No fatal error on unmarshal.

### SQLite WAL consistency under multi-host load

20 hosts × 1 Hz × 4 GPUs = 80 inserts/s. The existing batch logic (`buffer.push` + flush every 60 s, see `gpuCollector.ts`) stays relevant: aggregate on the hub before flushing, same origin as the single-host code. Test with a synthetic load script (mock agent) before release.

### The hub is no longer just a dashboard

Multi-host = the hub becomes a critical point of failure. Document that the SQLite DB remains a single file (no cluster), and that the recommended backup strategy (`data/gpuviewr.db` + WAL) remains valid but must be followed more diligently. No HA in scope.

### Docker socket permissions

None. The agent does **not** touch the Docker socket. It invokes `nvidia-smi` just like the hub does today. Side bonus: the agent can run as non-root if nvidia-smi is readable.

---

## Explicitly out of scope

- No multi-host UI in these PRs ("display, we'll see later"). The `src/` frontend is not touched by milestones 1-5 except to stay tolerant of the `host_id` field (can be done in a separate mini commit: a tolerant parser that ignores `host_id` in the meantime).
- No cross-organization RBAC (every admin user of the hub can manage every host).
- No auto-discovery (mDNS/Consul).
- No mTLS / cert pinning (TLS delegated to the reverse proxy).
- No SQLite sharding or replication.
- No cross-host series aggregation in `/api/gpu/history` (one chart = one host at a time in v1).

---

## 11. Display (multi-host UI): proposed design

Target: v0.3.1, after the multi-host backbone (milestones 1-5). Pattern: **hybrid** (fleet view + host drill-down), like Tailscale / Portainer / Coolify.

### 11.1 Three new routes / views

1. **`/fleet`: Fleet view (new)**, the first thing an admin sees after login if more than one host exists.
   - Top banner: 3 aggregated figures, `Online: 4/5`, `GPUs: 12`, `Power: 1.2 kW`.
   - Responsive grid of cards (1 col mobile / 2 tablet / 3-4 desktop).
   - 1 card = 1 host: label, status dot (green/yellow/red), dimmed hostname, GPU count, hottest GPU (60s sparkline), total power, relative last_seen.
   - Click a card → `/host/:id` (drill-down).
   - Offline cards greyed out, "offline 6m" badge on the dot.

2. **`/host/:id`: Host view (current Dashboard rewired)**. This is `src/components/dashboard/Dashboard.tsx` as is, but bound to a `host_id` via a router param.
   - `useGpuStream()` filters on `host_id` at WS subscription.
   - `Fleet > rtx-rig` breadcrumb to go back up.
   - The existing GPU selector gains a Host selector on its left (a consistent "host · gpu" combo).
   - If `host.status === 'offline'`, a non-blocking overlay "Host offline, last seen 6m ago", but the last known data keeps being displayed + a "View history" button.

3. **`/settings/hosts`: Settings → Hosts (admin only)**
   - Table: Label / Status pill / GPUs / Agent version / Last seen / Actions (rename, rotate token, disable, delete).
   - The `+ Add host` button opens the enrollment modal:
     - A single `label` field to fill in.
     - Submit → `POST /api/hosts` → the modal turns into "Token (copy now, shown once)" + a `docker run …` snippet with click-to-copy.
     - Strong red warning before closing.
   - "Rotate token" modal: confirmation + new token shown once.

### 11.2 Global header: permanent indicator

`src/components/layout/Header.tsx` (already existing) gains a clickable mini widget right of the logo:

```
[●] Fleet 4/5
```

- Aggregated dot: green if all online, yellow if ≥1 lagging, red if ≥1 offline.
- Click → `/fleet`.
- Hidden if only one host (`local`) exists: the single-host user sees no visual change.

### 11.3 Components to create

| Component | Role | Notes |
|---|---|---|
| `src/components/fleet/FleetView.tsx` | `/fleet` page | Layout + aggregates + grid |
| `src/components/fleet/HostCard.tsx` | 1 host card | Includes temp sparkline, status pill |
| `src/components/fleet/StatusPill.tsx` | Dot + label "Online 3s / Lagging 47s / Offline 6m" | Reused everywhere |
| `src/components/fleet/FleetIndicator.tsx` | Header mini widget | Reacts to `host_status` WS events |
| `src/components/settings/HostsTable.tsx` | Table in Settings | Pagination if > 50 hosts |
| `src/components/settings/EnrollHostModal.tsx` | Enrollment modal + token display | Copy-to-clipboard with mask |
| `src/components/settings/RotateTokenModal.tsx` | Confirmation + new token | Same as enroll but without a new row |

### 11.4 Store / data flow

- New Zustand store `useHostsStore` (see the existing pattern in `src/store/`): `hosts: Host[]`, `status: Map<host_id, HostStatus>`, `selectedHostId: string | null`.
- Initial hydration via `GET /api/hosts` at app boot.
- The `/ws/gpu` WS subscription now receives `{type:'host_status', host_id, status, last_seen}` messages that mutate the store.
- `Dashboard.tsx` reads `selectedHostId` from the store or the router param.

### 11.5 Zero-config single-host behavior (preserved)

If `GET /api/hosts` returns a single host with `kind='local'`:
- Header `FleetIndicator` hidden.
- `/fleet` still reachable but redirects to `/host/local` (i.e. `/`).
- No "Add host" visible unless the user is an admin (already the current semantics for Settings).

### 11.6 Mobile

- `/fleet` cards: 1-col grid, vertical scroll.
- Header `FleetIndicator`: just the dot + figure, no "Fleet" word.
- Full-screen enrollment modal.
- Host drill-down unchanged (the Dashboard is already responsive).

### 11.7 UI out of scope (v0.3.1)

- No "Compare hosts" mode (cross-host multi-series overlay), reserved for v0.4.
- No "host went offline" toast notification: a dot change is enough for v0.3.
- No host groups / tags: flat list.
- No geo map / network visualization.

---

## 12. Agent options: supported env vars

Minimal and stable surface. Everything is documented in `agent/README.md`.

### 12.1 Required variables (handshake)

| Variable | Role | Notes |
|---|---|---|
| `HUB_URL` | Hub URL, e.g. `wss://hub.example.com/agent` | `ws://` allowed only to loopback / RFC1918 (see §3). Fatal error at boot otherwise. |
| `HOST_ID` | UUID given by the hub at enrollment | Stable, never regenerated. Must match the `hosts` row on the hub. |
| `AGENT_TOKEN` | Opaque secret given by the hub at enrollment | Only one chance to copy it. Compared via `bcrypt.compare` on the hub. |

(Later addition: since v0.5.0 the plural `HUB_URLS` / `HOST_IDS` / `AGENT_TOKENS` let one agent report to several hubs; the singular forms still work.)

### 12.2 Optional variables (behavior)

| Variable | Default | Role |
|---|---|---|
| `TICK_MS` | `1000` | GPU collector cadence. The hub can override it through a `config` frame. |
| `FEATURES` | `gpu,system,temps,processes` | CSV list of active collectors. Disable `processes` on machines without a shared `/proc`. |
| `AGENT_BUFFER_PERSIST` | `0` | See D5. If `1`: append-only mirror in `$DATA_DIR/agent-buffer.jsonl`, 10 MiB rotation. |
| `AGENT_LABEL` | (none) | Initial label proposed to the hub via `hello`. If the hub already has an admin-defined label, the hub's wins. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. Aligned with the hub logger. |
| `NVIDIA_SMI_PATH` | `nvidia-smi` | Override if the binary is in an unusual path. Useful on WSL2, bare metal without a standard `/usr/bin`. |
| `HOST_PROC` | `/host/proc` | Process name resolution without `pid: host`. Same as the hub today. |
| `RECONNECT_MAX_MS` | `30000` | Exponential backoff cap. Implicit min = 1 s, jitter ±20%. |
| `TLS_INSECURE` | `0` | Skip cert verification (dev only). Permanent `warn` log if active. |
| `HTTPS_PROXY` / `HTTP_PROXY` | (none) | Corporate proxy. Standard Node `undici`, free. |

### 12.3 Deliberately absent

- No `JWT_SECRET` on the agent (D7: opaque auth, disjoint space).
- No `RETENTION_DAYS` / `DATA_DIR` on the agent unless `AGENT_BUFFER_PERSIST=1`: the hub does the storage.
- No auto-update: the user runs `docker pull` then `restart`. (Superseded in v0.5.3: opt-in auto-update over the WS via the `agent_update` frame for bare-metal agents; Docker agents still update by pulling the image.)
- No "dev mode" switch: either the agent runs or it does not.

### 12.4 Implicit startup behaviors (not configurable, documented)

- If `nvidia-smi` is missing → fatal, exit 1 (no silent mode pretending everything is fine). (Superseded in v0.3.1: `GPU_VENDOR=auto` probes `nvidia-smi` and `rocm-smi`; later Windows PDH and macOS `powermetrics` collectors were added.)
- If the `hello` frame is rejected (invalid token, host_id collision) → exit 1, **no** infinite retry loop.
- If the hub returns a `protocol_ver` higher than the agent's `MAX_KNOWN` → exit 1, message "upgrade agent".
- All SIGTERM / SIGINT signals → flush the RAM buffer, close the WS cleanly with code 1000, exit 0.

---

## 13. Pre-implementation: remaining checks

Triage of the "open questions" that deserve a check before starting milestone 1.

### 13.1 Blockers (to confirm before writing the first line)

1. **bcrypt performance when N agents connect**: if 20 agents restart simultaneously after a hub outage, we chain 20 synchronous `bcrypt.compare` calls. At ~80 ms each = 1.6 s of event loop blocking.
   - Action: quick bench + LRU cache `token_hash → host_id` after the first successful compare (TTL 1 h, invalidated on `rotate-token`).
   - File: to add in `server/services/agentIngestWS.ts` (milestone 3).

2. **`EXPLAIN QUERY PLAN` on the `(host_id, gpu_index, timestamp_epoch)` index**: check that legacy `WHERE gpu_index=? AND timestamp_epoch>?` queries (without explicit `host_id`) keep an acceptable cost after migration.
   - Action: run the existing test suite with `EXPLAIN QUERY PLAN` enabled, compare pre/post migration on a production DB.
   - Otherwise: keep a secondary `(gpu_index, timestamp_epoch)` index OR systematically inject `host_id='local'` in legacy (single-host) code.

3. **Idempotent migration under crash**: the `gpu_metrics → gpu_metrics_new` migration can crash between steps.
   - Action: at boot, DROP an orphan `gpu_metrics_new` before retrying. Test with a simulated `kill -9` midway.
   - File: `server/database/connection.ts` (milestone 2).

### 13.2 To benchmark (not blocking but to measure before release)

4. **20 hosts × 4 GPUs × 1 Hz SQLite inserts**: the existing batch logic (`flushIntervalMs=60s`) must hold.
   - Action: mock agent simulating 20 hosts. Otherwise: `INSERT OR IGNORE` + more aggressive WAL checkpoint.

5. **WS bandwidth**: theoretical = ~4 KB/s/host. Confirm that JSON serialization does not blow this up (floats can take 8-10 chars vs 4 binary bytes).
   - Optional post-v0.3: switch to CBOR / MessagePack if > 10 KB/s/host is observed.

6. **Agent memory footprint**: target < 100 MiB RSS. If > 150 MiB → `--max-old-space-size=80`.

### 13.3 To decide midway (not before milestone 3)

7. **Dynamically negotiated capabilities**: can an agent change `capabilities` mid-session?
   - Outcome: as proposed. Sent in `hello` and stored at each connection; they only change when the agent restarts (v0.10.4 adds the `ptrace` state).

8. **Behavior when a host is deleted on the hub but its agent is still connected**: close immediately or let it run?
   - Outcome: deleting a host does not close the live socket; the agent is refused with `4001` at its next connection. Disabling a host closes the socket at once with `4003`. `1008` is only used for the rate limit.

9. **GPU composition changing on a host** (card added / removed): `gpu_devices` upsert or DELETE?
   - Outcome: no `removed_at`. Rows are upserted per (host, GPU index); a removed card keeps its row and `last_seen`, so history is kept.

### 13.4 To document before release

10. **Remote host prerequisites**: NVIDIA Container Toolkit + `nvidia-smi` + reachable outbound port. README section.
11. **Single binary via Node SEA**: check on Node 22.19+ that `--experimental-sea-config` produces a usable binary on Debian 12 / Ubuntu 22+. If it breaks, fall back to the Docker image only. (Superseded in v0.3.0: SEA was not adopted, bare metal uses `install.sh` + the `agent.mjs` bundle.)
12. **Reverse proxy compat**: nginx/Caddy/Traefik pass WS upgrades by default, but some custom setups do not. Config snippet in the docs.
13. **CI**: add `agent/Dockerfile` to the Snyk Container matrix. Add the `/agent` typecheck/build to `CI / build`.

### 13.5 Residual non-blocking risks (CHANGELOG)

14. Prom breaking change: new `host=` label → single-host Grafana dashboards to migrate (PromQL snippet in `Docs/MIGRATION.md`).
15. MQTT breaking change: `gpuviewr/<host>/...` prefix → HA Discovery templates to recreate.
16. Discord/Telegram webhooks: the alert title must inject the host label. Otherwise a user receives "GPU #0 temperature firing" without knowing which of their 5 machines is complaining.

---

## 14. Integrating the multi-host preview into the real app

> **Done in v0.3.1.** The components now live in `src/components/fleet/` and `src/components/settings/`; the preview sandbox (`src/preview-multi/`, `index.preview.html`, `vite.preview.config.ts`) was deleted from the repo afterwards. This section is kept as the integration log.

Target: v0.3.1, **after** backbone milestones 1-5. The preview was a disconnected sandbox. To wire it for real, 7 steps ordered by dependency.

### 14.1 Backbone first

The preview assumes the existence of: the `hosts` table, `GET /api/hosts`, WS messages `{ type:'host_status', host_id, status }`. All of these arrive in milestones 2-3. **No UI integration until these APIs exist.**

### 14.2 1-to-1 component migration

| Preview (sandbox) | Production (real app) |
|---|---|
| `src/preview-multi/components/StatusPill.tsx` | `src/components/fleet/StatusPill.tsx` |
| `src/preview-multi/components/HostCard.tsx` | `src/components/fleet/HostCard.tsx` |
| `src/preview-multi/components/FleetIndicator.tsx` | `src/components/layout/FleetIndicator.tsx` (injected into `Header.tsx`) |
| `src/preview-multi/components/Sparkline.tsx` | **delete**: reuse the existing `src/components/dashboard/Sparkline.tsx` |
| `src/preview-multi/components/EnrollHostModal.tsx` | `src/components/settings/EnrollHostModal.tsx` |
| `src/preview-multi/pages/FleetView.tsx` | `src/components/fleet/FleetPage.tsx` |
| `src/preview-multi/pages/HostsSettings.tsx` | `src/components/settings/HostsSettingsTab.tsx` |

The code is ~90% transposable as is: it already follows the existing CSS tokens (`--gv-*`, `.card`, `.btn-primary`).

### 14.3 New Zustand store `useHostsStore`

File: `src/store/hostsStore.ts` (~80 lines). Pattern aligned with the existing stores.

State:
- `hosts: Host[]`: hydrated at boot via `fetch('/api/hosts')`
- `liveSamples: Map<host_id, GpuSample[]>`: fed by the existing WS hook
- `selectedHostId: string | null`: for the drill-down
- `status: Map<host_id, HostStatus>`

Actions: `refresh()`, `enroll(label)`, `rotate(id)`, `rename(id, label)`, `remove(id, purgeMetrics)`.

### 14.4 React Router routes

`src/App.tsx` gains:

```
<Route path="/fleet"          element={<FleetPage/>} />
<Route path="/host/:id"       element={<Dashboard/>} />
<Route path="/settings/hosts" element={<Settings tab="hosts"/>} />
```

`Dashboard.tsx` reads `useParams().id` (or `useHostsStore(s => s.selectedHostId)`) and passes this `host_id` to the GPU APIs.

### 14.5 Single-host behavior (zero-touch)

```
const hostCount = useHostsStore(s => s.hosts.length);
if (hostCount <= 1) return null;            // header indicator hidden
// router: /fleet redirects to /host/local if there is a single host
```

The single-host user **sees nothing new**: no indicator, no visible Fleet tab. Reachable only by typing the URL by hand.

### 14.6 i18n

The app uses `react-i18next`. All preview strings (~30 strings) must go through `t()` and land in `src/i18n/locales/{en,fr,...}.json`. Mechanical work, but not to be forgotten.

### 14.7 Permissions

`EnrollHostModal`, rotate, delete: visible only if `user.role === 'admin'`. Standard wrapper:

```
const isAdmin = useAuthStore(s => s.user?.role === 'admin');
if (!isAdmin) return <Redirect to="/" />;
```

### 14.8 Leaving the sandbox after v0.3.1

**Proposed decision: delete** `src/preview-multi/` + `index.preview.html` + `vite.preview.config.ts` + the `dev:preview`/`build:preview` scripts once v0.3.1 is out. Less surface to maintain, the sandbox will have served its purpose.

Alternative option (to reassess in v0.3.1): keep it as a design iteration tool for future changes without a running backend.

---

## 15. Agent installation (end-user side)

Target how-to for `agent/README.md` and the "Add a remote host" section of the main README.

### 15.0 Supported OSes

**Common prerequisites**: NVIDIA drivers installed + `nvidia-smi` reachable (path configurable via `NVIDIA_SMI_PATH`), outbound TCP to the hub.

| OS | Arch | Mode | Status |
|---|---|---|---|
| Linux glibc (Debian 11+/Ubuntu 22+/RHEL 9+/Rocky/Alma/Fedora 38+/openSUSE) | x86_64 | Docker **or** systemd SEA binary | Tier 1 |
| Linux glibc Jetson / Grace | arm64 | Docker **or** systemd SEA binary | Tier 1 |
| Windows + WSL2 (NVIDIA WSL driver ≥ 470) | x86_64 | Agent inside WSL2, **not native Windows** | Tier 1 |
| Linux musl (Alpine bare metal) | x86_64 | Docker only (glibc container OK on a musl host) | Tier 2 |

**Not supported in v0.3**: native Windows (no NVIDIA Container Toolkit, no `/proc` → processCollector broken, Service Manager ≠ systemd). macOS (Apple Silicon has no NVIDIA, NVIDIA dropped post-Mojave Mac support). (Superseded: native Windows agent in v0.6.7 (Scheduled Task, `install.ps1`), with AMD / Intel via PDH in v0.7.0 and a process list in v0.9.17; macOS Apple Silicon agent via `powermetrics` in v0.9.0. AMD / ROCm on Linux since v0.3.1.)

**Technical details**:
- Multi-arch Docker image `linux/amd64` + `linux/arm64`, distroless or `node:22-alpine` base, ~50-60 MiB compressed.
- Prebuilt SEA binary for `linux-x64` and `linux-arm64-gnu`, linked against glibc 2.31+ (Debian 11 / Ubuntu 22 / RHEL 9).
- The agent **does not depend** on `better-sqlite3` (no SQLite on the agent): no mandatory native compilation, the SEA binary is portable across glibc distros without a rebuild.
- `--gpus all` is mandatory with Docker, otherwise `nvidia-smi: command not found` inside the container (expected error #1).

### 15.1 Admin side (hub): 3 clicks

1. **Settings → Hosts** in the GpuViewR UI.
2. **+ Add host**, type a label (e.g. `rtx-rig`), confirm.
3. The hub shows **only once**: Host ID (UUID), Agent token (secret), ready-to-paste `docker run` snippet.

Modal closed = token permanently lost on the hub (only its bcrypt hash remains). If lost: the `Rotate token` button generates a new secret, and the agent must be reconfigured.

### 15.2 Remote node side: 3 install modes

> **Current recipes are in [`Docs/REMOTE_HOSTS.md`](REMOTE_HOSTS.md).** The examples below are the original design: the compose files are now `docker-compose.agent.nvidia.yaml` / `docker-compose.agent.amd.yaml` (they also mount `/proc` and add `SYS_PTRACE` for the process list), and bare metal uses `install.sh`.

**Mode 1: Docker (recommended, 95% of cases)**

```bash
docker run -d --name gpuviewr-agent \
  --gpus all \
  --restart unless-stopped \
  -e HUB_URL=wss://gpu.example.com/agent \
  -e HOST_ID="<host-uuid>" \
  -e AGENT_TOKEN=gpvr_<long-token> \
  ghcr.io/erreur32/gpuviewr-agent:latest
```

Host prerequisites:
- NVIDIA Container Toolkit installed (`nvidia-ctk --version`)
- Outbound TCP 443 (or custom port) to the hub
- `nvidia-smi` working in a test container (`docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`)

**Mode 2: Docker Compose**

`docker-compose.agent.yml` file distributed with the project:

```yaml
services:
  agent:
    image: ghcr.io/erreur32/gpuviewr-agent:latest
    restart: unless-stopped
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
    environment:
      HUB_URL: ${HUB_URL}
      HOST_ID: ${HOST_ID}
      AGENT_TOKEN: ${AGENT_TOKEN}
      TICK_MS: 1000
      FEATURES: gpu,system,temps,processes
```

Workflow: `.env` + `docker compose -f docker-compose.agent.yml up -d`. Plain-text config, easy restart.

**Mode 3: systemd bare metal (Node SEA binary)**

(Superseded in v0.3.0: no SEA binary was shipped. Bare-metal installs use the hub-served `install.sh` (`curl … | bash`), which installs Node 22 and the `agent.mjs` bundle under `/opt/gpuviewr-agent/` with a systemd unit. The recipe below is kept as the original design.)

For nodes without Docker (university HPC, old bare-metal boxes):

```bash
# 1. Download the binary (~50 MiB)
curl -L -o /usr/local/bin/gpuviewr-agent \
  https://github.com/Erreur32/GpuViewR/releases/download/v0.3.0/gpuviewr-agent-linux-x64
chmod +x /usr/local/bin/gpuviewr-agent

# 2. Env file (mode 600)
cat > /etc/gpuviewr-agent.env <<EOF
HUB_URL=wss://gpu.example.com/agent
HOST_ID=550e8400-...
AGENT_TOKEN=gpvr_...
EOF
chmod 600 /etc/gpuviewr-agent.env

# 3. systemd service
cat > /etc/systemd/system/gpuviewr-agent.service <<EOF
[Unit]
Description=GpuViewR Agent
After=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/gpuviewr-agent.env
ExecStart=/usr/local/bin/gpuviewr-agent
Restart=on-failure
RestartSec=5
User=nobody

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now gpuviewr-agent
```

To provide at release: prebuilt Node SEA binary for `linux/amd64`, `linux/arm64`. No mac/windows (rare use case for remote GPUs).

### 15.3 Connection check

Admin side: the new host's card turns green "Online" within 1-3 s. If it stays red "Offline":

- Agent logs: `docker logs gpuviewr-agent` or `journalctl -u gpuviewr-agent -f`
- Typical errors:
  - `ECONNREFUSED` → wrong hub URL or hub down
  - `4001` close → invalid token or host_id mismatch → rotate on the admin side + reconfigure (the plan said `1008`, now only the rate limit)
  - `nvidia-smi not found` → NVIDIA Container Toolkit not installed on the host
  - repeated `1006 abnormal closure` → TLS / proxy blocks WS upgrades → review the reverse proxy config

### 15.4 Updating

- Docker: `docker pull ghcr.io/erreur32/gpuviewr-agent:latest && docker restart gpuviewr-agent`
- systemd: download the new binary, `systemctl restart gpuviewr-agent` (today: auto-update, or `curl -fsSL <hub>/install.sh | sudo bash -s -- --upgrade` to refresh bundle and unit)

No built-in auto-update (see §12.3). (Superseded in v0.5.3: bare-metal agents can be auto-updated by the hub over the WS, opt-in per host; Windows since v0.6.7, macOS since v0.9.0.)

### 15.5 Removal

1. Node side: `docker rm -f gpuviewr-agent` (or `systemctl disable --now gpuviewr-agent`).
2. Admin UI: Settings → Hosts → row → `🗑 Delete` (with a "purge history" checkbox).
