import { Router } from 'express';
import { processCollector, type GpuProcess } from '../services/processCollector.js';
import { getActiveCollector } from '../services/activeGpuCollector.js';
import { agentProcessStore } from '../services/agentProcessStore.js';
import { metricsBus } from '../services/_metricsBus.js';
import { LOCAL_HOST_ID } from '../database/models/Host.js';
import type { GpuSample } from '../services/parsers/nvidia.js';

const router = Router();

router.get('/', async (req, res) => {
  const hostRaw = req.query.host;
  const host = typeof hostRaw === 'string' && hostRaw.trim() !== '' ? hostRaw.trim() : LOCAL_HOST_ID;
  const filterRaw = req.query.gpu;

  // Snapshot resolution depends on host:
  //   - LOCAL_HOST_ID → hub's own processCollector (real-time, cached)
  //   - any other id  → agent-supplied snapshot from agentProcessStore;
  //                     null means agent never reported or snapshot is
  //                     older than the store's TTL.
  let processes: GpuProcess[] = [];
  let tsEpoch = Math.floor(Date.now() / 1000);
  let samples: GpuSample[] = [];
  let reason: string | undefined;

  if (host === LOCAL_HOST_ID) {
    const snap = await processCollector.getSnapshot();
    processes = snap.processes;
    tsEpoch = Math.floor(snap.ts / 1000);
    samples = getActiveCollector().getLatest();
  } else {
    const remote = agentProcessStore.get(host);
    if (remote) {
      processes = remote.processes;
      tsEpoch = remote.ts;
      samples = metricsBus.getLatestByHost(host);
    } else {
      reason = 'no recent process snapshot from this agent (capability disabled or agent offline)';
    }
  }

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
  if (typeof filterRaw === 'string' && filterRaw !== '') {
    const idx = Number.parseInt(filterRaw, 10);
    if (Number.isFinite(idx)) {
      filtered = enriched.filter((p) => p.gpu_index === idx);
    }
  }

  res.json({
    host,
    timestamp_epoch: tsEpoch,
    count: filtered.length,
    processes: filtered,
    ...(reason ? { reason } : {}),
  });
});

export default router;
