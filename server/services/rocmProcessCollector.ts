// rocm-smi process collector for the hub. Sibling of processCollector.ts
// (the nvidia one); exposes the same Snapshot shape so /api/processes
// doesn't care which vendor is wired.
//
// rocm-smi quirks already encoded in the parser layer (parsers/rocm):
//   - --showpids returns a single CSV string per PID, not an object.
//   - Empty case = stdout empty, exit 0, harmless WARNING on stderr.
//   - No equivalent of nvidia-smi pmon → gpu_pct is always null.
//   - No process type (C/G/G+C) — defaults to 'C' (compute) which
//     covers what ROCm overwhelmingly hosts in practice.
//   - --showpids tells us *how many* cards a pid uses, not which one
//     — fine on single-card AMD boxes. Multi-card logs one warning;
//     proper --showpidgpus integration is a follow-up.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { spawnRocmSmi, spawnSyncRocmSmi } from '../utils/rocmSmi.js';
import { parseRocmInfo, parseRocmPids, rocmUuidFromBus } from './parsers/rocm.js';
import { buildFakeProcesses } from './mockGpu.js';
import { getActiveCollector } from './activeGpuCollector.js';
import type { GpuProcess } from './processCollector.js';

interface Snapshot {
  ts: number;
  processes: GpuProcess[];
}

const PIDS_FLAGS = ['--showpids', '--showbus', '--json'];
const CACHE_MS = 1500;
const CLK_TCK = 100;
const PROC_ROOT = process.env.HOST_PROC ?? '/proc';

class RocmProcessCollector {
  private last: Snapshot = { ts: 0, processes: [] };
  private inflight: Promise<Snapshot> | null = null;
  private rocmSmiAvailable: boolean | null = null;
  private readonly cpuPrev: Map<number, { ticks: number; ts: number }> = new Map();
  private multiCardWarned = false;

  async getSnapshot(): Promise<Snapshot> {
    if (Date.now() - this.last.ts < CACHE_MS) return this.last;
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private checkRocmSmi(): boolean {
    if (this.rocmSmiAvailable !== null) return this.rocmSmiAvailable;
    try {
      this.rocmSmiAvailable = spawnSyncRocmSmi(config.rocmSmiPath, ['--version'], 3_000).status === 0;
    } catch {
      this.rocmSmiAvailable = false;
    }
    return this.rocmSmiAvailable;
  }

  private refresh(): Promise<Snapshot> {
    if (config.mockGpu) {
      const samples = getActiveCollector().getLatest();
      this.last = { ts: Date.now(), processes: buildFakeProcesses(samples) };
      return Promise.resolve(this.last);
    }
    if (!this.checkRocmSmi()) {
      this.last = { ts: Date.now(), processes: [] };
      return Promise.resolve(this.last);
    }
    return new Promise((resolve) => {
      const child = spawnRocmSmi(config.rocmSmiPath, PIDS_FLAGS);
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      // libdrm + "No JSON data to report" warnings — both benign.
      child.stderr.on('data', () => { /* ignore */ });
      child.on('error', () => {
        this.last = { ts: Date.now(), processes: [] };
        resolve(this.last);
      });
      child.on('close', (code) => {
        if (code !== 0) {
          this.last = { ts: Date.now(), processes: [] };
          resolve(this.last);
          return;
        }
        const procs = parseRocmPids(stdout);
        const info = parseRocmInfo(stdout);
        const uuids = info.cards.map((c) => rocmUuidFromBus(c.raw['PCI Bus']));
        const defaultUuid = uuids[0] ?? 'ROCm-unknown';
        if (info.cards.length > 1 && !this.multiCardWarned) {
          this.multiCardWarned = true;
          logger.warn('proc', 'multi-GPU AMD detected; all processes will be attributed to card0 until --showpidgpus integration lands');
        }
        const enriched: GpuProcess[] = procs.map((p) => this.enrich(p, defaultUuid));
        // Drop CPU bookkeeping for pids we no longer see.
        const seen = new Set(procs.map((p) => p.pid));
        for (const pid of this.cpuPrev.keys()) {
          if (!seen.has(pid)) this.cpuPrev.delete(pid);
        }
        this.last = { ts: Date.now(), processes: enriched };
        resolve(this.last);
      });
    });
  }

  private enrich(
    p: ReturnType<typeof parseRocmPids>[number],
    defaultUuid: string,
  ): GpuProcess {
    const usedMiB = Math.floor(p.vram_used_bytes / 1048576);
    const command = readCmdline(p.pid);
    const name = p.process_name || resolveName(p.pid) || 'unknown';
    return {
      pid: p.pid,
      process_name: name,
      gpu_uuid: defaultUuid,
      used_memory: usedMiB,
      type: 'C',
      command,
      cpu_pct: this.sampleCpu(p.pid),
      gpu_pct: null,
    };
  }

  private sampleCpu(pid: number): number | null {
    const ticks = readProcTicks(pid);
    if (ticks === null) return null;
    const now = Date.now();
    const prev = this.cpuPrev.get(pid);
    this.cpuPrev.set(pid, { ticks, ts: now });
    if (!prev) return null;
    const dt = (now - prev.ts) / 1000;
    if (dt <= 0) return null;
    const dTicks = ticks - prev.ticks;
    if (dTicks < 0) return null;
    return Math.round((dTicks / (dt * CLK_TCK)) * 100 * 10) / 10;
  }
}

function resolveName(pid: number): string | null {
  try {
    const cmdline = readFileSync(`${PROC_ROOT}/${pid}/cmdline`, 'utf8');
    const argv0 = cmdline.split('\0')[0];
    if (argv0) return basename(argv0);
  } catch { /* fall through */ }
  try {
    const comm = readFileSync(`${PROC_ROOT}/${pid}/comm`, 'utf8').trim();
    if (comm) return comm;
  } catch { /* ignore */ }
  return null;
}

function readCmdline(pid: number): string | null {
  try {
    const raw = readFileSync(`${PROC_ROOT}/${pid}/cmdline`, 'utf8');
    if (!raw) return null;
    return raw.replaceAll('\0', ' ').trim() || null;
  } catch {
    return null;
  }
}

function readProcTicks(pid: number): number | null {
  try {
    const stat = readFileSync(`${PROC_ROOT}/${pid}/stat`, 'utf8');
    const after = stat.lastIndexOf(')');
    if (after < 0) return null;
    const fields = stat.slice(after + 2).split(' ');
    const utime = Number.parseInt(fields[11], 10);
    const stime = Number.parseInt(fields[12], 10);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return utime + stime;
  } catch {
    return null;
  }
}

export const rocmProcessCollector = new RocmProcessCollector();
