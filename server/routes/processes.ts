import { Router } from 'express';
import { processCollector } from '../services/processCollector.js';
import { gpuCollector } from '../services/gpuCollector.js';

const router = Router();

router.get('/', async (req, res) => {
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
    const idx = parseInt(filterRaw, 10);
    if (Number.isFinite(idx)) {
      processes = enriched.filter((p) => p.gpu_index === idx);
    }
  }

  res.json({
    timestamp_epoch: Math.floor(snap.ts / 1000),
    count: processes.length,
    processes,
  });
});

export default router;
