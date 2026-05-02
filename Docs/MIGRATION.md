# Migration from bigsk1/gpu-monitor → GpuViewR

GpuViewR is a from-scratch reimplementation but preserves the **`gpu_metrics`
SQLite schema** so existing histories can be imported optionally.

## Option A — Fresh start (recommended)

Simplest path. Stop the old container, start GpuViewR, register the first user.

```bash
# stop old
docker compose -f /path/to/old/gpu-monitor/docker-compose.yml down

# start new
cd ~/GpuViewR
docker compose up -d
```

Open `http://localhost:3010` — register the first account (becomes admin).
You lose the old historical data, but you start clean on the new schema
(extra columns: gpu_index, fan_speed, clocks).

## Option B — Import old history

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

Then start GpuViewR — your old history is now visible in the dashboard.

## Port and environment changes

| Old (`gpu-monitor`) | New (`GpuViewR`) |
|---|---|
| Port `8081` | Port `3010` (configurable via `PORT`) |
| No auth | First user becomes admin (set `JWT_SECRET` in `.env`) |
| `./history`, `./logs` volumes | `./data` (single volume) |
| Bash + Python | Node 22 (TypeScript) |
| Polling 5–30 s | WebSocket streaming 1 s |
