// Lightweight host-level stats (CPU, load, memory) shared between the
// /system route and webhook payloads. CPU usage is a delta against the
// previous os.cpus() snapshot, so we maintain it on a fixed 1-second
// interval and let callers read the most recent computed value — that
// way a webhook firing once a minute doesn't get a "first call = 0"
// reading and the /system route isn't fighting for the snapshot.
import os from 'node:os';

export interface SystemStats {
  hostname: string;
  uptime: number;
  cpu: {
    model: string;
    cores: number;
    speedMHz: number;
    usagePct: number;
  };
  load: {
    '1m': number;
    '5m': number;
    '15m': number;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    usedPct: number;
  };
}

let prev: { idle: number; total: number } | null = null;
let lastUsagePct = 0;

function tickCpuUsage(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  if (prev === null) {
    prev = { idle, total };
    return lastUsagePct;
  }
  const idleDelta = idle - prev.idle;
  const totalDelta = total - prev.total;
  prev = { idle, total };
  if (totalDelta <= 0) return lastUsagePct;
  const pct = (1 - idleDelta / totalDelta) * 100;
  lastUsagePct = Math.max(0, Math.min(100, pct));
  return lastUsagePct;
}

let timer: NodeJS.Timeout | null = null;

export function startSystemStats(): void {
  if (timer) return;
  // Prime the snapshot so the first read after startup has a baseline.
  tickCpuUsage();
  timer = setInterval(() => { tickCpuUsage(); }, 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

export function getSystemStats(): SystemStats {
  // Refresh on read too — cheap and ensures the value is at most ~1s old
  // even if the interval missed a tick (e.g. event loop pressure).
  tickCpuUsage();
  const cpus = os.cpus();
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const [l1, l5, l15] = os.loadavg();
  return {
    hostname: os.hostname(),
    uptime: os.uptime(),
    cpu: {
      model: cpus[0]?.model?.trim() || 'Unknown CPU',
      cores: cpus.length,
      speedMHz: cpus[0]?.speed ?? 0,
      usagePct: lastUsagePct,
    },
    load: { '1m': l1, '5m': l5, '15m': l15 },
    memory: {
      total,
      free,
      used,
      usedPct: total > 0 ? (used / total) * 100 : 0,
    },
  };
}
