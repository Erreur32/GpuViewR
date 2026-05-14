# Migration from bigsk1/gpu-monitor → GpuViewR

GpuViewR is a from-scratch reimplementation but preserves the **`gpu_metrics`
SQLite schema** so existing histories can be imported optionally.

## Option A: Fresh start (recommended)

Simplest path. Stop the old container, start GpuViewR, register the first user.

```bash
# stop old
docker compose -f /path/to/old/gpu-monitor/docker-compose.yml down

# start new
cd ~/GpuViewR
docker compose up -d
```

Open `http://localhost:3010`: register the first account (becomes admin).
You lose the old historical data, but you start clean on the new schema
(extra columns: gpu_index, fan_speed, clocks).

## Option B: Import old history

The old DB lives at `<old-dir>/history/gpu_metrics.db`. Run the importer once:

```bash
sqlite3 data/gpuviewr.db <<'SQL'
ATTACH DATABASE '/path/to/old/history/gpu_metrics.db' AS legacy;

INSERT INTO gpu_metrics
  (gpu_index, timestamp, timestamp_epoch, temperature, utilization,
   memory_used, memory_total, power, fan_speed, clock_graphics, clock_memory)
SELECT
  0,
  timestamp,
  timestamp_epoch,
  temperature,
  utilization,
  memory,        -- legacy "memory" column → memory_used
  NULL,          -- memory_total unknown in legacy schema
  power,
  NULL, NULL, NULL
FROM legacy.gpu_metrics
WHERE NOT EXISTS (
  SELECT 1 FROM gpu_metrics m
  WHERE m.gpu_index = 0 AND m.timestamp_epoch = legacy.gpu_metrics.timestamp_epoch
);

DETACH DATABASE legacy;
SQL
```

Then start GpuViewR: your old history is now visible in the dashboard.

## v0.2.x → v0.3.x : multi-host migration

v0.3.0 introduces the [multi-host architecture](MULTI_HOST_PLAN.md). The
upgrade is **zero-touch for the database** — the boot-time migration
backfills every existing `gpu_metrics` / `gpu_devices` / `alert_events`
row with `host_id='local'` and seeds the `hosts` table with a row for
the hub itself. Your history is preserved.

What **does** change is the wire format of the exports. Mono-host
installs continue to work but the labels / tags / topics evolved:

### Prometheus (`/metrics`)

Every series now carries an extra `host="<id>"` label. For mono-host
installs the value is the literal `local`. A side metric
`gpuviewr_host_info{host="<id>"} 1` is emitted per enrolled host so
dashboards can join on the human label later.

**Impact on existing Grafana dashboards**: queries that don't filter
on `host` keep working (they aggregate over every host, which is just
"local" for mono-host installs). Queries that group by `gpu` will
need to be rewritten to `sum by (gpu) (...)` if you want the old
"sum across whatever-host-this-was" behaviour. For a multi-host fleet,
this is exactly what you want.

Hub-side host metrics (CPU / load / memory) also gained the
`host="local"` label and renamed the OS-hostname dimension from
`host=...` to `os_hostname=...`. Update PromQL templates accordingly.

### InfluxDB

The GPU measurement now carries a `host=<id>` tag (in addition to
the existing `gpu_index`, `name`, `uuid`).

The hub-system measurement (`*_host`) renamed its `host=<hostname>`
tag to `os_host=<hostname>` to avoid colliding with the new
multi-host `host` tag.

### MQTT

Topic shape changed from `gpuviewr/gpu<N>/state` to
`gpuviewr/<host_id>/gpu<N>/state`. Mono-host installs see
`gpuviewr/local/gpu0/state` etc.

**Home Assistant Discovery**: discovery topics and `unique_id`s now
include the host id, so previously-discovered entities will look
"deleted" and new ones will appear under host-prefixed names. To
clean up, in Home Assistant: Settings → Integrations → MQTT → expand
device → "Delete" the orphans before the new ones get picked up.

### Webhook

Payload gained a `samples_by_host` key (object of `host_id → samples[]`).
The flat `samples` array is preserved for compatibility with
existing v0.2.x receivers. Alert event payloads now also carry
`host_id` and the digest message used by Discord/Telegram prefixes
multi-host alerts with the host id so you know which machine is hot.

### Alert rules

Every alert rule gained an optional `host_id` field. `NULL` (the
default) means "applies to every host" — symmetric with the existing
`gpu_index NULL = all GPUs` convention. Set it to a specific host id
to scope a rule.

## Port and environment changes

| Old (`gpu-monitor`) | New (`GpuViewR`) |
|---|---|
| Port `8081` | Port `3010` (configurable via `PORT`) |
| No auth | First user becomes admin (set `JWT_SECRET` in `.env`) |
| `./history`, `./logs` volumes | `./data` (single volume) |
| Bash + Python | Node 22 (TypeScript) |
| Polling 5–30 s | WebSocket streaming 1 s |
