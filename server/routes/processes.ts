import { Router } from 'express';
import { type GpuProcess, type ProcessVisibility } from '../services/_processTypes.js';
import { agentProcessStore } from '../services/agentProcessStore.js';
import { hiddenProcesses } from '../services/processVisibility.js';
import { processHistory } from '../services/processHistory.js';
import { HostsRepo } from '../database/models/Host.js';
import { metricsBus } from '../services/_metricsBus.js';
import { LOCAL_HOST_ID } from '../database/models/Host.js';
import type { GpuSample } from '../services/parsers/nvidia.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/** Top processes of a host over the last N hours (1-168, default 24). */
router.get('/history', (req, res) => {
  const host = typeof req.query.host === 'string' && req.query.host.trim() !== '' ? req.query.host.trim() : LOCAL_HOST_ID;
  const hoursRaw = Number.parseInt(String(req.query.hours ?? '24'), 10);
  const hours = Number.isFinite(hoursRaw) ? Math.min(168, Math.max(1, hoursRaw)) : 24;
  const indexByUuid = new Map(metricsBus.getLatestByHost(host).map((s) => [s.uuid, s.gpu_index]));
  const top = processHistory.top(host, hours).map((r) => ({ ...r, gpu_index: indexByUuid.get(r.gpu_uuid) ?? null }));
  res.json({ host, hours, top });
});

/** Every LLM process across the fleet, from the live snapshots. */
router.get('/llm', (_req, res) => {
  const rows = [];
  for (const host of HostsRepo.list()) {
    const snap = agentProcessStore.get(host.id);
    if (!snap) continue;
    const samples = metricsBus.getLatestByHost(host.id);
    for (const p of snap.processes) {
      if (!p.llm_runtime) continue;
      const card = samples.find((s) => s.uuid === p.gpu_uuid);
      rows.push({
        host_id: host.id,
        host_label: host.label || host.hostname || host.id,
        gpu_index: card?.gpu_index ?? null,
        gpu_name: card?.name ?? null,
        ...p,
      });
    }
  }
  res.json({ processes: rows });
});

router.get('/', async (req, res) => {
  const hostRaw = req.query.host;
  const host = typeof hostRaw === 'string' && hostRaw.trim() !== '' ? hostRaw.trim() : LOCAL_HOST_ID;
  const filterRaw = req.query.gpu;

  // Snapshot resolution: every host (local sidecar or remote) feeds
  // its process snapshot through the same agentProcessStore. v0.5
  // removed the special LOCAL_HOST_ID branch — the local sidecar is
  // just another agent now.
  let processes: GpuProcess[] = [];
  let tsEpoch = Math.floor(Date.now() / 1000);
  let samples: GpuSample[] = [];
  let reason: string | undefined;
  let visibility: ProcessVisibility | undefined;

  const snap = agentProcessStore.get(host);
  if (snap) {
    processes = snap.processes;
    visibility = snap.visibility;
    tsEpoch = snap.ts;
    samples = metricsBus.getLatestByHost(host);
  } else {
    reason = host === LOCAL_HOST_ID
      ? 'no local sidecar agent connected yet (check docker compose status)'
      : 'no recent process snapshot from this agent (capability disabled or agent offline)';
  }
  await Promise.resolve(); // keep route async for upstream typings

  // Map gpu_uuid → gpu_index using whichever per-host samples we have.
  // Processes are reported by uuid but the WebSocket samples key by
  // index, so the frontend needs the index for its filter.
  const uuidToIndex = new Map<string, number>();
  for (const s of samples) {
    if (s.uuid) uuidToIndex.set(s.uuid, s.gpu_index);
  }
  const enriched = processes.map((p) => ({
    ...p,
    gpu_index: uuidToIndex.get(p.gpu_uuid) ?? null,
  }));

  let filtered = enriched;
  let gpuIdx: number | null = null;
  if (typeof filterRaw === 'string' && filterRaw !== '') {
    const idx = Number.parseInt(filterRaw, 10);
    if (Number.isFinite(idx)) {
      gpuIdx = idx;
      filtered = enriched.filter((p) => p.gpu_index === idx);
    }
  }

  const hidden = visibility ? hiddenProcesses(visibility, samples, filtered, gpuIdx) : null;

  res.json({
    host,
    timestamp_epoch: tsEpoch,
    count: filtered.length,
    processes: filtered,
    ...(reason ? { reason } : {}),
    ...(hidden ? { hidden } : {}),
  });
});

export default router;
