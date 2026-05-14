import { Router } from 'express';
import { gpuCollector } from '../services/gpuCollector.js';
import { HostsRepo } from '../database/models/Host.js';
import { config } from '../config.js';

const router = Router();

router.get('/', (_req, res) => {
  const samples = gpuCollector.getLatest();
  const hosts = HostsRepo.list();
  const now = Math.floor(Date.now() / 1000);
  let online = 0;
  let lagging = 0;
  let offline = 0;
  for (const h of hosts) {
    if (h.status === 'online') {
      // Treat agents that haven't been seen in >15s as lagging in the
      // health view, even if the 30s watchdog hasn't tipped them to
      // 'offline' yet. Mirrors the UI traffic-light heuristic.
      if (h.kind === 'agent' && h.last_seen !== null && now - h.last_seen > 15) lagging++;
      else online++;
    } else if (h.status === 'offline') {
      offline++;
    }
  }
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    gpuCount: samples.length,
    hostsTotal: hosts.length,
    hostsOnline: online,
    hostsLagging: lagging,
    hostsOffline: offline,
    nodeEnv: config.nodeEnv,
    mockGpu: config.mockGpu,
    timestamp: new Date().toISOString(),
  });
});

export default router;
