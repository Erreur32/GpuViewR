import { Router } from 'express';
import { processCollector } from '../services/processCollector.js';
import { gpuCollector } from '../services/gpuCollector.js';
import { LOCAL_HOST_ID } from '../database/models/Host.js';

const router = Router();

router.get('/', async (req, res) => {
  // Per-host process listing isn't wired to agents in v0.3.0 — the
  // agent's processes capability is reserved for a later jalon. For
  // `?host=<non-local>` we return an empty list with a hint rather
  // than 404 so the UI can degrade gracefully.
  const hostRaw = req.query.host;
  const host = typeof hostRaw === 'string' && hostRaw.trim() !== '' ? hostRaw.trim() : LOCAL_HOST_ID;
  if (host !== LOCAL_HOST_ID) {
    res.json({
      host,
      timestamp_epoch: Math.floor(Date.now() / 1000),
      count: 0,
      processes: [],
      reason: 'processes are not yet collected from remote agents (reserved for a later release)',
    });
    return;
  }

  const snap = await processCollector.getSnapshot();
  const filterRaw = req.query.gpu;
  // Map gpu_uuid back to gpu_index for the frontend (the WebSocket
  // samples key everything by index, processes are reported by uuid).
  const samples = gpuCollector.getLatest();
  const uuidToIndex = new Map<string, number>();
  for (const s of samples) {
    if (s.uuid) uuidToIndex.set(s.uuid, s.gpu_index);
  }

  const enriched = snap.processes.map((p) => ({
    ...p,
    gpu_index: uuidToIndex.get(p.gpu_uuid) ?? null,
  }));

  let processes = enriched;
  if (typeof filterRaw === 'string' && filterRaw !== '') {
    const idx = Number.parseInt(filterRaw, 10);
    if (Number.isFinite(idx)) {
      processes = enriched.filter((p) => p.gpu_index === idx);
    }
  }

  res.json({
    host,
    timestamp_epoch: Math.floor(snap.ts / 1000),
    count: processes.length,
    processes,
  });
});

export default router;
