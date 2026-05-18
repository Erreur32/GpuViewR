// Per-host GPU-process collector for the agent.
//
// Mirrors the hub's server/services/processCollector.ts but stays
// self-contained — no hub imports — because the agent ships as its
// own binary and may run on a host where the hub code isn't present.
//
// Output shape matches the wire frame the hub's agentIngestWS
// dispatches on `case 'processes':`: { tsEpoch, processes[] } where
// each process carries pid, name, gpu_uuid, used_memory, plus the
// nvtop-style enrichment (type, command, cpu_pct, gpu_pct).

import { spawn, spawnSync } from 'node:child_process';
import { logger } from '../logger.js';
import { createCpuSampler, readCmdline, resolveProcessName } from './_procTicks.js';
import { classifyLLM, type LLMResolvers } from './llmClassifier.js';

export type GpuProcessType = 'C' | 'G' | 'G+C' | null;

export interface AgentGpuProcess {
  pid: number;
  process_name: string;
  gpu_uuid: string;
  used_memory: number;        // MiB
  type: GpuProcessType;       // C = Compute, G = Graphics, G+C = both
  command: string | null;     // full /proc/<pid>/cmdline, NULs → spaces
  cpu_pct: number | null;     // % of a single core, sampled between ticks
  gpu_pct: number | null;     // GPU SM utilization for this pid (from pmon)
  // LLM-aware fields (v0.7.3+, palier 3). Best-effort classification
  // of the process command line against known local-inference stacks
  // (Ollama, llama.cpp, vLLM, ComfyUI, KoboldCpp, oobabooga, …).
  // Both null when the cmdline doesn't match any known pattern.
  llm_runtime?: string | null;
  llm_model?: string | null;
}

export interface ProcessSnapshot {
  tsEpoch: number;
  processes: AgentGpuProcess[];
}

export type ProcessCollectorOptions = Readonly<{
  nvidiaSmiPath: string;
  tickMs: number;
  hostProc: string;
  onSnapshot: (snap: ProcessSnapshot) => void;
  /** Optional resolvers passed to the LLM classifier. The Ollama
   *  resolver translates blob digests into friendly model names —
   *  no-op for processes that aren't ollama runners or when no
   *  manifests dir is reachable. */
  llmResolvers?: LLMResolvers;
}>;

export interface ProcessCollectorHandle {
  start(): void;
  stop(): void;
  available(): boolean;
}

// Cap how often we spawn nvidia-smi — process churn rarely exceeds
// once a second and clients see updates throttled by REFRESH_MS in
// the table anyway.
const MIN_TICK_MS = 1_000;

const QUERY = ['pid', 'process_name', 'gpu_uuid', 'used_memory'].join(',');

export function createProcessCollector(opts: ProcessCollectorOptions): ProcessCollectorHandle {
  const tickMs = Math.max(opts.tickMs, MIN_TICK_MS);
  let timer: NodeJS.Timeout | null = null;
  let nvidiaSmiAvailable: boolean | null = null;
  let inflight = false;
  const cpuSampler = createCpuSampler(opts.hostProc);

  function checkNvidiaSmi(): boolean {
    if (nvidiaSmiAvailable !== null) return nvidiaSmiAvailable;
    try {
      const r = spawnSync(opts.nvidiaSmiPath, ['--version'], { timeout: 3_000 });
      nvidiaSmiAvailable = r.status === 0;
    } catch {
      nvidiaSmiAvailable = false;
    }
    return nvidiaSmiAvailable;
  }

  function spawnComputeApps(): Promise<AgentGpuProcess[]> {
    return new Promise((resolve) => {
      const child = spawn(opts.nvidiaSmiPath, [
        `--query-compute-apps=${QUERY}`,
        '--format=csv,noheader,nounits',
      ]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', () => resolve([]));
      child.on('close', (code) => {
        if (code !== 0) {
          if (stderr.trim()) logger.debug('proc', `nvidia-smi compute-apps exited ${code}: ${stderr.trim()}`);
          resolve([]);
          return;
        }
        resolve(parseComputeApps(stdout, opts.hostProc));
      });
    });
  }

  function spawnPmon(): Promise<Map<number, { type: GpuProcessType; gpuPct: number | null }>> {
    return new Promise((resolve) => {
      const child = spawn(opts.nvidiaSmiPath, ['pmon', '-c', '1', '-s', 'u']);
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.on('error', () => resolve(new Map()));
      child.on('close', (code) => {
        if (code !== 0) { resolve(new Map()); return; }
        resolve(parsePmon(stdout));
      });
    });
  }

  async function tick(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const [procs, pmonByPid] = await Promise.all([spawnComputeApps(), spawnPmon()]);
      const enriched: AgentGpuProcess[] = procs.map((p) => {
        const pmon = pmonByPid.get(p.pid);
        const command = readCmdline(p.pid, opts.hostProc);
        const llm = classifyLLM(command, opts.llmResolvers);
        return {
          ...p,
          type: pmon?.type ?? (command ? 'C' : null),
          command,
          cpu_pct: cpuSampler.sample(p.pid),
          gpu_pct: pmon?.gpuPct ?? null,
          llm_runtime: llm.runtime,
          llm_model: llm.model,
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
      return checkNvidiaSmi();
    },
    start(): void {
      if (timer) return;
      if (!checkNvidiaSmi()) {
        logger.warn('proc', `nvidia-smi not available at ${opts.nvidiaSmiPath} — process collector disabled`);
        return;
      }
      logger.success('proc', `Process collector started (tick=${tickMs}ms, hostProc=${opts.hostProc})`);
      void tick();
      timer = setInterval(() => { void tick(); }, tickMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function parseComputeApps(out: string, procRoot: string): AgentGpuProcess[] {
  const procs: AgentGpuProcess[] = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0], 10);
    if (!Number.isFinite(pid)) continue;
    const used = Number.parseInt(parts[3], 10);
    let name = parts[1] || '';
    if (!name || name === '[Not Found]' || name === '-' || name.toLowerCase() === 'n/a') {
      name = resolveProcessName(pid, procRoot) || 'unknown';
    }
    procs.push({
      pid,
      process_name: name,
      gpu_uuid: parts[2] || '',
      used_memory: Number.isFinite(used) ? used : 0,
      type: null,
      command: null,
      cpu_pct: null,
      gpu_pct: null,
    });
  }
  return procs;
}

function parsePmon(out: string): Map<number, { type: GpuProcessType; gpuPct: number | null }> {
  const result = new Map<number, { type: GpuProcessType; gpuPct: number | null }>();
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(pid)) continue;
    const typeRaw = parts[2];
    let type: GpuProcessType = null;
    if (typeRaw === 'C' || typeRaw === 'G' || typeRaw === 'G+C') type = typeRaw;
    const sm = Number.parseInt(parts[3], 10);
    result.set(pid, { type, gpuPct: Number.isFinite(sm) ? sm : null });
  }
  return result;
}
