import { Router } from 'express';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { metricsBus } from '../services/_metricsBus.js';
import { LOCAL_HOST_ID } from '../database/models/Host.js';
import { getDatabase } from '../database/connection.js';
import { GpuMetricRepository } from '../database/models/GpuMetric.js';
import { AppConfigRepo } from '../database/models/AppConfig.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { hostHostname } from '../utils/hostHostname.js';
import { readHostTemperatures } from '../services/systemTemperatures.js';

const RETENTION_KEY = 'retention_days';
const DEFAULT_RETENTION_DAYS = config.retentionDays;

const router = Router();
router.use(requireAuth);

interface OsRelease {
  name: string;
  prettyName: string | null;
  version: string | null;
  id: string | null;
}

function readOsRelease(): OsRelease {
  const fallback: OsRelease = {
    name: `${os.type()} ${os.release()}`,
    prettyName: null,
    version: null,
    id: null,
  };
  try {
    if (!fs.existsSync('/etc/os-release')) return fallback;
    const content = fs.readFileSync('/etc/os-release', 'utf8');
    const map: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) map[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
    return {
      name: map.NAME || fallback.name,
      prettyName: map.PRETTY_NAME || null,
      version: map.VERSION || map.VERSION_ID || null,
      id: map.ID || null,
    };
  } catch {
    return fallback;
  }
}

function readCpuModel(): string {
  const cpus = os.cpus();
  return cpus[0]?.model?.trim() || 'Unknown CPU';
}

function readLoadAvg(): number[] {
  return os.loadavg();
}

// Aggregate CPU usage % over the elapsed time between calls. We snapshot
// /proc/stat-style counters returned by os.cpus() and diff against the
// previous snapshot. The first call returns 0 (no baseline yet).
let prevCpuSnapshot: { idle: number; total: number } | null = null;

function readCpuUsagePct(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  if (prevCpuSnapshot === null) {
    prevCpuSnapshot = { idle, total };
    return 0;
  }
  const idleDelta = idle - prevCpuSnapshot.idle;
  const totalDelta = total - prevCpuSnapshot.total;
  prevCpuSnapshot = { idle, total };
  if (totalDelta <= 0) return 0;
  const pct = (1 - idleDelta / totalDelta) * 100;
  return Math.max(0, Math.min(100, pct));
}

router.get('/', (_req, res) => {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const cpus = os.cpus();
  // The system page's GPU strip mirrors the local sidecar's view. With
  // v0.5+ the local row in metricsBus is fed by the sidecar agent.
  const samples = metricsBus.getLatestByHost(LOCAL_HOST_ID);

  res.json({
    host: {
      hostname: hostHostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptime: os.uptime(),
      loadavg: readLoadAvg(),
      os: readOsRelease(),
    },
    cpu: {
      model: readCpuModel(),
      cores: cpus.length,
      speedMHz: cpus[0]?.speed ?? 0,
      usagePct: readCpuUsagePct(),
    },
    memory: {
      total,
      free,
      used,
      usedPct: total > 0 ? (used / total) * 100 : 0,
    },
    process: {
      nodeVersion: process.version,
      pid: process.pid,
      uptime: process.uptime(),
      rss: process.memoryUsage().rss,
    },
    temperatures: readHostTemperatures(),
    gpus: samples.map((s) => ({
      gpu_index: s.gpu_index,
      name: s.name,
      uuid: s.uuid,
      driver_version: s.driver_version,
      memory_total: s.memory_total,
      memory_used: s.memory_used,
      temperature: s.temperature,
      utilization: s.utilization,
      power: s.power,
      fan_speed: s.fan_speed,
      clock_graphics: s.clock_graphics,
      clock_memory: s.clock_memory,
      pci_bus_id: s.pci_bus_id,
      pcie_gen_current: s.pcie_gen_current,
      pcie_gen_max: s.pcie_gen_max,
      pcie_width_current: s.pcie_width_current,
      pcie_width_max: s.pcie_width_max,
      // Effective unidirectional bandwidth (GB/s) for the *current* link.
      // Per-lane figures from PCI-SIG: gen1 0.25, gen2 0.5, gen3 0.985,
      // gen4 1.969, gen5 3.938 GB/s. Returns null if either current value
      // is missing (older drivers, virtualised GPUs).
      pcie_bandwidth_GBps: pcieBandwidthGBps(s.pcie_gen_current, s.pcie_width_current),
      pcie_bandwidth_max_GBps: pcieBandwidthGBps(s.pcie_gen_max, s.pcie_width_max),
      pcie_rx_kbps: s.pcie_rx_kbps ?? null,
      pcie_tx_kbps: s.pcie_tx_kbps ?? null,
    })),
  });
});

const PCIE_PER_LANE_GBPS: Record<number, number> = {
  1: 0.25,
  2: 0.5,
  3: 0.985,
  4: 1.969,
  5: 3.938,
  6: 7.563,
};

function pcieBandwidthGBps(gen: number | null, width: number | null): number | null {
  if (!gen || !width) return null;
  const perLane = PCIE_PER_LANE_GBPS[gen];
  if (!perLane) return null;
  return Math.round(perLane * width * 100) / 100;
}

function getRetentionDays(): number {
  const stored = AppConfigRepo.get(RETENTION_KEY);
  const n = stored ? Number.parseInt(stored, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

router.get('/db', (_req, res) => {
  const db = getDatabase();
  const counts = db
    .prepare('SELECT COUNT(*) AS c, MIN(timestamp_epoch) AS minE, MAX(timestamp_epoch) AS maxE FROM gpu_metrics')
    .get() as { c: number; minE: number | null; maxE: number | null };
  let dbBytes = 0;
  try {
    const dbPath = path.join(config.dataDir, 'gpuviewr.db');
    dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + ext)) dbBytes += fs.statSync(dbPath + ext).size;
    }
  } catch {
    // ignore
  }
  const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  res.json({
    rows: counts.c,
    oldestEpoch: counts.minE,
    newestEpoch: counts.maxE,
    sizeBytes: dbBytes,
    pageCount,
    pageSize,
    retentionDays: getRetentionDays(),
    journalMode: (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
  });
});

router.put('/db/retention', requireAdmin, (req, res) => {
  const days = Number.parseInt(String((req.body as { days?: unknown })?.days ?? ''), 10);
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return res.status(400).json({ error: 'days must be an integer between 1 and 365' });
  }
  AppConfigRepo.set(RETENTION_KEY, String(days));
  logger.info('DB', `Retention updated to ${days}d (was ${getRetentionDays()}d default)`);
  res.json({ retentionDays: days });
});

router.post('/db/purge', requireAdmin, (req, res) => {
  const body = req.body as { mode?: string; beforeEpoch?: number };
  const db = getDatabase();
  let removed = 0;
  if (body?.mode === 'all') {
    const info = db.prepare('DELETE FROM gpu_metrics').run();
    removed = Number(info.changes || 0);
  } else if (body?.mode === 'retention') {
    const days = getRetentionDays();
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    removed = GpuMetricRepository.pruneOlderThan(cutoff);
  } else if (typeof body?.beforeEpoch === 'number') {
    removed = GpuMetricRepository.pruneOlderThan(body.beforeEpoch);
  } else {
    return res.status(400).json({ error: 'mode must be "all", "retention", or beforeEpoch must be set' });
  }
  // Reclaim disk space.
  db.exec('VACUUM');
  logger.info('DB', `Purge mode=${body?.mode}: ${removed} rows deleted, VACUUM run.`);
  res.json({ removed });
});

export default router;
