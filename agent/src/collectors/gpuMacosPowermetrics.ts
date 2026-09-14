// macOS (Apple Silicon) GPU collector — spawns a long-running
// `sudo -n powermetrics --samplers gpu_power,smc -f plist` and parses
// one plist document per tick from stdout. Same long-running-spawn
// shape as gpuWindowsPdh.ts (powermetrics has a ~0.5-1s sampler warmup,
// so spawning it fresh every tick would waste both time and a laptop's
// battery — cf. Docs/MACOS_AGENT.md §1.2).
//
// Field-name caveat: powermetrics' plist schema for the gpu_power/smc
// samplers isn't officially documented by Apple and drifts a bit across
// macOS/chip generations (cf. plan §2.1). `extractMacGpuFields` below is
// deliberately tolerant — it walks the whole parsed tree looking for a
// handful of plausible key names rather than asserting one fixed shape.
// It has only been validated against synthetic fixtures reconstructed
// from public documentation, not a real `powermetrics` capture; treat
// the exact key list as "best effort pending a real Apple Silicon Mac"
// (cf. PR3/PR5 in the plan).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { GpuSample } from '../../../server/services/parsers/nvidia.js';
import { nowTimestamp } from '../../../server/services/parsers/nvidia.js';
import { logger } from '../logger.js';
import { parsePlistDocument, type PlistValue } from './plist.js';
import {
  getMacGpuName,
  getMacMemoryTotalMb,
  getMacMemoryUsedMb,
  getMacOsVersion,
} from './macosSysctl.js';

export type MacosPowermetricsOptions = Readonly<{
  tickMs: number;
  onSample: (samples: GpuSample[]) => void;
  /** Override for tests. Defaults to `/usr/bin/powermetrics`. */
  powermetricsPath?: string;
}>;

export interface MacosPowermetricsHandle {
  start(): void;
  stop(): void;
  available(): boolean;
}

const DEFAULT_BIN = '/usr/bin/powermetrics';

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Splits a stdout buffer accumulated from `powermetrics -f plist` on the
 *  NUL (`\x00`) separator Apple inserts between samples. Returns the
 *  complete documents found plus whatever partial tail remains buffered. */
export function splitPlistDocs(buf: Buffer): { docs: string[]; rest: Buffer } {
  const docs: string[] = [];
  let start = 0;
  let nul = buf.indexOf(0, start);
  while (nul >= 0) {
    const doc = buf.subarray(start, nul).toString('utf8').trim();
    if (doc) docs.push(doc);
    start = nul + 1;
    nul = buf.indexOf(0, start);
  }
  return { docs, rest: buf.subarray(start) };
}

interface MacGpuFields {
  /** 0-100. */
  utilization: number | null;
  freqMhz: number | null;
  powerMw: number | null;
  tempC: number | null;
}

function pathHasGpu(path: string[]): boolean {
  return path.some((p) => /gpu/i.test(p));
}

/** Walks the parsed plist tree, visiting every (key, value, path) triple. */
function walk(
  value: PlistValue,
  path: string[],
  visit: (key: string, value: PlistValue, path: string[]) => void,
): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, [...path, String(i)], visit));
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    visit(key, v, path);
    walk(v, [...path, key], visit);
  }
}

/** Tolerant extractor — see module doc for why this isn't a fixed schema. */
export function extractMacGpuFields(root: PlistValue): MacGpuFields {
  let freqMhz: number | null = null;
  let idleRatio: number | null = null;
  let activeResidencyPct: number | null = null;
  let energyMj: number | null = null;
  let elapsedNs: number | null = null;
  let tempC: number | null = null;
  let powerMwDirect: number | null = null;

  walk(root, [], (rawKey, value, path) => {
    const k = rawKey.toLowerCase();

    if (k === 'elapsed_ns' && typeof value === 'number') elapsedNs = value;

    const gpuScoped = pathHasGpu(path) || k.includes('gpu');
    if (!gpuScoped) return;

    if ((k === 'freq_hz' || k === 'freq_mhz') && typeof value === 'number' && freqMhz === null) {
      freqMhz = k === 'freq_hz' ? value / 1e6 : value;
    }
    if (k.includes('hw active frequency') && typeof value === 'number' && freqMhz === null) {
      freqMhz = value;
    }
    if (k === 'idle_ratio' && typeof value === 'number' && idleRatio === null) {
      idleRatio = value;
    }
    if (k.includes('idle residency') && typeof value === 'number' && idleRatio === null) {
      idleRatio = value > 1 ? value / 100 : value;
    }
    if (
      k.includes('active') &&
      (k.includes('residency') || k.includes('ratio')) &&
      typeof value === 'number' &&
      activeResidencyPct === null
    ) {
      activeResidencyPct = value <= 1 ? value * 100 : value;
    }
    if (k === 'gpu_energy' && typeof value === 'number' && energyMj === null) {
      energyMj = value;
    }
    if (k.includes('power') && !k.includes('energy') && typeof value === 'number' && powerMwDirect === null) {
      // "GPU Power" human-readable-style key, already in mW.
      powerMwDirect = value;
    }
    if (k.includes('die temperature') && typeof value === 'number' && tempC === null) {
      tempC = value;
    }
    if (k.includes('temp') && !k.includes('template') && typeof value === 'number' && tempC === null) {
      tempC = value;
    }
  });

  const utilization =
    activeResidencyPct !== null
      ? Math.round(clamp(activeResidencyPct, 0, 100))
      : idleRatio !== null
        ? Math.round(clamp((1 - idleRatio) * 100, 0, 100))
        : null;

  const powerMw =
    energyMj !== null && elapsedNs !== null && elapsedNs > 0
      ? energyMj / (elapsedNs / 1e9)
      : powerMwDirect;

  return { utilization, freqMhz, powerMw, tempC };
}

export function createMacosPowermetricsCollector(
  opts: MacosPowermetricsOptions,
): MacosPowermetricsHandle {
  const bin = opts.powermetricsPath || DEFAULT_BIN;
  let child: ChildProcessWithoutNullStreams | null = null;
  let started = false;
  let sudoOk: boolean | null = null;
  let buf = Buffer.alloc(0);

  let gpuName = 'Apple GPU';
  let osVersion: string | null = null;
  let memoryTotalMb: number | null = null;

  function handleDoc(doc: string): void {
    let root: PlistValue;
    try {
      root = parsePlistDocument(doc);
    } catch (err) {
      logger.debug('gpu', `powermetrics: bad plist doc (${(err as Error).message})`);
      return;
    }
    const fields = extractMacGpuFields(root);
    const { iso, epoch } = nowTimestamp();
    const memoryUsedMb = getMacMemoryUsedMb(memoryTotalMb);
    const sample: GpuSample = {
      gpu_index: 0,
      name: gpuName,
      uuid: null,
      driver_version: osVersion,
      temperature: fields.tempC ?? 0,
      utilization: fields.utilization,
      memory_used: memoryUsedMb ?? 0,
      memory_total: memoryTotalMb,
      power: fields.powerMw !== null ? fields.powerMw / 1000 : 0,
      fan_speed: null,
      clock_graphics: fields.freqMhz !== null ? Math.round(fields.freqMhz) : null,
      clock_memory: null,
      pci_bus_id: null,
      pcie_gen_current: null,
      pcie_gen_max: null,
      pcie_width_current: null,
      pcie_width_max: null,
      pcie_rx_kbps: null,
      pcie_tx_kbps: null,
      timestamp: iso,
      timestamp_epoch: epoch,
    };
    opts.onSample([sample]);
  }

  function spawnPowermetrics(): void {
    try {
      child = spawn('sudo', [
        '-n',
        bin,
        '--samplers',
        'gpu_power,smc',
        '-i',
        String(opts.tickMs),
        '-f',
        'plist',
      ]);
    } catch (err) {
      logger.error('gpu', `powermetrics spawn threw: ${(err as Error).message}`);
      return;
    }

    child.stdout.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const { docs, rest } = splitPlistDocs(buf);
      buf = Buffer.from(rest);
      for (const doc of docs) handleDoc(doc);
    });
    child.stderr.on('data', (d: Buffer) => {
      const msg = d.toString('utf8').trim();
      if (msg) logger.debug('gpu', `powermetrics stderr: ${msg.slice(0, 200)}`);
    });
    child.on('error', (err) => logger.error('gpu', `powermetrics error: ${err.message}`));
    child.on('close', (code) => {
      child = null;
      buf = Buffer.alloc(0);
      if (started) {
        logger.warn('gpu', `powermetrics exited (code=${code}), respawning in 3s`);
        setTimeout(() => {
          if (started) spawnPowermetrics();
        }, 3_000).unref();
      }
    });
  }

  return {
    available(): boolean {
      if (process.platform !== 'darwin') return false;
      if (sudoOk !== null) return sudoOk;
      try {
        const r = spawnSync('sudo', ['-n', bin, '-h'], { timeout: 3_000 });
        sudoOk = r.status === 0;
        if (!sudoOk) {
          const stderr = (r.stderr || Buffer.alloc(0)).toString('utf8').trim();
          logger.error(
            'gpu',
            `powermetrics unavailable via 'sudo -n' (${stderr || `exit ${r.status}`}). Check /etc/sudoers.d/gpuviewr-agent.`,
          );
        }
      } catch (err) {
        sudoOk = false;
        logger.error('gpu', `sudo probe threw: ${(err as Error).message}`);
      }
      return sudoOk;
    },
    start(): void {
      if (started) return;
      started = true;
      gpuName = getMacGpuName();
      osVersion = getMacOsVersion();
      memoryTotalMb = getMacMemoryTotalMb();
      logger.success(
        'gpu',
        `powermetrics collector started (tick=${opts.tickMs}ms, name=${gpuName}, memory=${memoryTotalMb ?? '?'}MiB)`,
      );
      spawnPowermetrics();
    },
    stop(): void {
      started = false;
      if (child) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        child = null;
      }
      buf = Buffer.alloc(0);
    },
  };
}

export const __test = { extractMacGpuFields, splitPlistDocs };
