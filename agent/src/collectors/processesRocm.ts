// Per-host GPU-process collector backed by `rocm-smi --showpids`.
// Same wire shape as the nvidia variant (AgentGpuProcess[]) so the
// hub's agentIngestWS doesn't care which vendor produced the frame.
//
// rocm-smi quirks worth knowing:
//  - --showpids returns a single CSV string per PID, not an object;
//    parsing lives in parsers/rocm.
//  - Empty case = stdout empty, exit 0, harmless WARNING on stderr.
//  - No equivalent of nvidia-smi pmon → gpu_pct is always null.
//  - No process type (C/G/G+C) — we set 'C' (compute) which is what
//    ROCm overwhelmingly hosts in practice.
//  - We bundle --showbus into the same call so we can map each pid to
//    a stable synthesized gpu_uuid (ROCm-${pciBus}). Cheap and avoids
//    a per-tick extra spawn.
//  - --showpids only tells us *how many* cards a pid uses, not which
//    one — fine on single-card AMD boxes (attribute everything to the
//    sole card). For multi-card AMD a follow-up will integrate
//    --showpidgpus; that case logs a one-shot warning.

import { spawn, spawnSync } from 'node:child_process';
import { parseRocmInfo, parseRocmPids, rocmUuidFromBus } from '../../../server/services/parsers/rocm.js';
import type { AgentGpuProcess, ProcessCollectorHandle, ProcessCollectorOptions, ProcessSnapshot } from './processes.js';
import { createCpuSampler, readCmdline } from './_procTicks.js';
import { logger } from '../logger.js';

export type { ProcessSnapshot };

const MIN_TICK_MS = 1_000;

const PIDS_FLAGS = ['--showpids', '--showbus', '--json'];

export type RocmProcessCollectorOptions = Omit<ProcessCollectorOptions, 'nvidiaSmiPath'> & {
  rocmSmiPath: string;
};

export function createRocmProcessCollector(opts: RocmProcessCollectorOptions): ProcessCollectorHandle {
  const tickMs = Math.max(opts.tickMs, MIN_TICK_MS);
  let timer: NodeJS.Timeout | null = null;
  let rocmSmiAvailable: boolean | null = null;
  let inflight = false;
  let multiCardWarned = false;
  const cpuSampler = createCpuSampler(opts.hostProc);

  function checkRocmSmi(): boolean {
    if (rocmSmiAvailable !== null) return rocmSmiAvailable;
    try {
      const r = spawnSync(opts.rocmSmiPath, ['--version'], { timeout: 3_000 });
      rocmSmiAvailable = r.status === 0;
    } catch {
      rocmSmiAvailable = false;
    }
    return rocmSmiAvailable;
  }

  function spawnPidsAndBus(): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(opts.rocmSmiPath, PIDS_FLAGS);
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      // libdrm warning + "No JSON data to report" both land here; both
      // are benign and the JSON we want sits on stdout. Drop silently.
      child.stderr.on('data', () => { /* ignore */ });
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(stdout));
    });
  }

  async function tick(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const out = await spawnPidsAndBus();
      const procs = parseRocmPids(out);
      const info = parseRocmInfo(out);

      // Build cardIndex → uuid map. On a single-card box (the only path
      // we currently support reliably for AMD) every pid attaches to
      // that one card.
      const uuids = info.cards.map((c) => rocmUuidFromBus(c.raw['PCI Bus']));
      const defaultUuid = uuids[0] ?? 'ROCm-unknown';
      if (info.cards.length > 1 && !multiCardWarned) {
        multiCardWarned = true;
        logger.warn('proc', 'multi-GPU AMD detected; all processes will be attributed to card0 until --showpidgpus integration lands');
      }

      const enriched: AgentGpuProcess[] = procs.map((p) => {
        const command = readCmdline(p.pid, opts.hostProc);
        const usedMiB = Math.floor(p.vram_used_bytes / 1048576);
        return {
          pid: p.pid,
          process_name: p.process_name || 'unknown',
          gpu_uuid: defaultUuid,
          used_memory: usedMiB,
          type: 'C',
          command,
          cpu_pct: cpuSampler.sample(p.pid),
          gpu_pct: null,
        };
      });
      cpuSampler.retain(new Set(procs.map((p) => p.pid)));
      opts.onSnapshot({ tsEpoch: Math.floor(Date.now() / 1000), processes: enriched });
    } finally {
      inflight = false;
    }
  }

  return {
    available(): boolean {
      return checkRocmSmi();
    },
    start(): void {
      if (timer) return;
      if (!checkRocmSmi()) {
        logger.warn('proc', `rocm-smi not available at ${opts.rocmSmiPath} — ROCm process collector disabled`);
        return;
      }
      logger.success('proc', `ROCm process collector started (tick=${tickMs}ms, hostProc=${opts.hostProc})`);
      void tick();
      timer = setInterval(() => { void tick(); }, tickMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
