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
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { logger } from '../logger.js';
import { createCpuSampler, readCmdline, readContainer, resolveProcessName } from './_procTicks.js';
import { classifyLLM, type LLMHint, type LLMResolvers } from './llmClassifier.js';
import { hasPtraceCap } from './processesAmdgpuFdinfo.js';

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
  /** Why llm_model is missing or not human-friendly (see LLMHint). */
  llm_hint?: LLMHint | null;
  /** Model state from the runtime's own API or VRAM: 'loaded', 'idle'
   *  (llama.cpp asleep, VRAM released), null when unknown. */
  llm_state?: 'loaded' | 'idle' | null;
  /** Ollama: epoch seconds the model unloads at (keep_alive), null otherwise. */
  llm_expires_at?: number | null;
  /** System RAM mapped to the GPU for this process (GTT), MiB. AMD APUs
   *  (Strix Halo...) keep model weights there, so VRAM alone undercounts. */
  gtt_memory?: number | null;
  /** Container the process runs in (cgroup), null on the host. */
  container_engine?: string | null;
  container_id?: string | null;
}

/** How much of the host the process collector can actually see. Only
 *  sent by collectors that can miss GPU clients (AMD fdinfo scan). */
export interface ProcessVisibility {
  /** Long-lived pids whose /proc/<pid>/fdinfo was refused. A GPU client
   *  among them is missing from the list. */
  denied_pids: number;
  /** Agent holds CAP_SYS_PTRACE: denials then come from AppArmor (Docker
   *  agent vs host processes), not from a missing capability. */
  has_ptrace: boolean;
  /** NVIDIA agent in its own pid namespace (Docker without `pid: host`):
   *  recent drivers (seen on 595) then hide every GPU process outside
   *  the agent's container from nvidia-smi. */
  pid_isolated?: boolean;
}

export interface ProcessSnapshot {
  tsEpoch: number;
  processes: AgentGpuProcess[];
  visibility?: ProcessVisibility;
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

/** True when the agent runs in its own pid namespace. Read through the
 *  host's /proc, its NSpid line then holds the host pid and the
 *  container pid; with `pid: host`, systemd or no /host/proc, one pid. */
export function inOwnPidNamespace(hostProc: string): boolean {
  try {
    const nspid = /^NSpid:\s*(.+)$/m.exec(readFileSync(`${hostProc}/self/status`, 'utf8'));
    return (nspid?.[1].trim().split(/\s+/).length ?? 1) > 1;
  } catch {
    return false;
  }
}

// Retry window for the bus id → UUID lookup when a GPU stays unmapped.
const UUID_MAP_TTL_MS = 60_000;

export function createProcessCollector(opts: ProcessCollectorOptions): ProcessCollectorHandle {
  const tickMs = Math.max(opts.tickMs, MIN_TICK_MS);
  let timer: NodeJS.Timeout | null = null;
  let nvidiaSmiAvailable: boolean | null = null;
  let inflight = false;
  const cpuSampler = createCpuSampler(opts.hostProc);
  // Fixed for the agent's life: sent with every snapshot so the hub can
  // explain unaccounted VRAM with the `pid: host` fix.
  const isolation: ProcessVisibility | null = inOwnPidNamespace(opts.hostProc)
    ? { denied_pids: 0, has_ptrace: hasPtraceCap(), pid_isolated: true }
    : null;

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

  /** Run nvidia-smi and resolve its stdout, or null on spawn error / non-zero exit. */
  function runSmi(args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(opts.nvidiaSmiPath, args);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code !== 0) {
          if (stderr.trim()) logger.debug('proc', `nvidia-smi ${args[0]} exited ${code}: ${stderr.trim()}`);
          resolve(null);
          return;
        }
        resolve(stdout);
      });
    });
  }

  // `nvidia-smi -q` keys its GPU blocks by PCI bus id, the hub keys
  // processes by GPU UUID. Cached because the mapping only changes on
  // hotplug; refreshed (throttled) when an unknown bus id shows up.
  let uuidByBus = new Map<string, string>();
  let uuidMapAt = 0;

  async function resolveUuids(busIds: string[]): Promise<void> {
    if (busIds.every((b) => uuidByBus.has(b))) return;
    if (Date.now() - uuidMapAt < UUID_MAP_TTL_MS) return;
    uuidMapAt = Date.now();
    const out = await runSmi(['--query-gpu=pci.bus_id,uuid', '--format=csv,noheader']);
    if (out !== null) uuidByBus = parseBusUuidMap(out);
  }

  async function tick(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const [computeOut, pidsOut] = await Promise.all([
        runSmi([`--query-compute-apps=${QUERY}`, '--format=csv,noheader,nounits']),
        // Only source that also lists graphics-only clients (Xorg,
        // compositors, browsers): --query-compute-apps skips them.
        runSmi(['-q', '-d', 'PIDS']),
      ]);
      const procs = computeOut === null ? [] : parseComputeApps(computeOut, opts.hostProc);
      const smiTypeByPid = new Map<number, GpuProcessType>();
      if (pidsOut !== null) {
        const listed = parseQueryPids(pidsOut);
        await resolveUuids(listed.map((e) => e.busId));
        mergeQueryPids(procs, listed, uuidByBus, opts.hostProc);
        for (const e of listed) if (e.type) smiTypeByPid.set(e.pid, e.type);
      }
      // pmon is the costliest call of the tick (~36 ms CPU on a 3060 Ti)
      // and only adds per-pid type + SM%, so it is skipped while no
      // process holds the GPU, which is most of the time on idle hosts.
      const pmonOut = procs.length > 0 ? await runSmi(['pmon', '-c', '1', '-s', 'u']) : null;
      const pmonByPid = pmonOut === null ? new Map() : parsePmon(pmonOut);
      const enriched: AgentGpuProcess[] = procs.map((p) => {
        const pmon = pmonByPid.get(p.pid);
        const command = readCmdline(p.pid, opts.hostProc);
        const llm = classifyLLM(command, opts.llmResolvers, p.pid);
        const container = readContainer(p.pid, opts.hostProc);
        return {
          ...p,
          type: pmon?.type ?? smiTypeByPid.get(p.pid) ?? (command ? 'C' : null),
          command,
          cpu_pct: cpuSampler.sample(p.pid),
          gpu_pct: pmon?.gpuPct ?? null,
          llm_runtime: llm.runtime,
          llm_model: llm.model,
          llm_hint: llm.hint,
          container_engine: container?.engine ?? null,
          container_id: container?.id ?? null,
        };
      });
      cpuSampler.retain(new Set(procs.map((p) => p.pid)));
      opts.onSnapshot({
        tsEpoch: Math.floor(Date.now() / 1000),
        processes: enriched,
        ...(isolation ? { visibility: isolation } : {}),
      });
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
      if (isolation) {
        logger.info('proc', 'agent runs in its own pid namespace: recent NVIDIA drivers then list no GPU process outside this container. If some are missing, add `pid: host` to the agent service.');
      }
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
    procs.push(bareProcess(pid, displayName(parts[1], pid, procRoot), parts[2] || '', Number.isFinite(used) ? used : 0));
  }
  return procs;
}

export function parsePmon(out: string): Map<number, { type: GpuProcessType; gpuPct: number | null }> {
  const result = new Map<number, { type: GpuProcessType; gpuPct: number | null }>();
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(pid)) continue;
    const sm = Number.parseInt(parts[3], 10);
    result.set(pid, { type: normalizeType(parts[2]), gpuPct: Number.isFinite(sm) ? sm : null });
  }
  return result;
}

/** Recent drivers print "C+G", older ones "G+C"; normalise to the latter. */
function normalizeType(raw: string): GpuProcessType {
  if (raw === 'C' || raw === 'G') return raw;
  if (raw === 'G+C' || raw === 'C+G') return 'G+C';
  return null;
}

function displayName(raw: string | undefined, pid: number, procRoot: string): string {
  const name = raw?.trim() ?? '';
  if (!name || name === '[Not Found]' || name === '-' || name.toLowerCase() === 'n/a') {
    return resolveProcessName(pid, procRoot) || 'unknown';
  }
  // nvidia-smi reports the full executable path; keep the basename
  // like the ROCm collector does, the full path is in `command`.
  return basename(name);
}

function normalizeBusId(id: string): string {
  return id.trim().toLowerCase();
}

export interface QueryPidsEntry {
  busId: string;
  pid: number;
  type: GpuProcessType;
  name: string;
  used_memory: number; // MiB, 0 when the driver doesn't report it (WDDM)
}

/**
 * Parse `nvidia-smi -q -d PIDS`. Unlike --query-compute-apps it lists
 * graphics clients too. Layout per GPU block:
 *
 *   GPU 00000000:01:00.0
 *       Processes
 *           Process ID                        : 1607
 *               Type                          : G
 *               Name                          : /usr/lib/xorg/Xorg
 *               Used GPU Memory               : 245 MiB
 */
export function parseQueryPids(out: string): QueryPidsEntry[] {
  const entries: QueryPidsEntry[] = [];
  for (const block of out.split(/^GPU\s+/m).slice(1)) {
    const busId = normalizeBusId(block.split('\n', 1)[0]);
    for (const chunk of block.split(/^\s*Process ID\s*:/m).slice(1)) {
      const pid = Number.parseInt(chunk, 10);
      if (!Number.isFinite(pid)) continue;
      const type = /^\s*Type\s*:\s*(\S+)/m.exec(chunk)?.[1] ?? '';
      const name = /^\s*Name\s*:\s*(.*)$/m.exec(chunk)?.[1] ?? '';
      const used = Number.parseInt(/^\s*Used GPU Memory\s*:\s*(.*)$/m.exec(chunk)?.[1] ?? '', 10);
      entries.push({
        busId,
        pid,
        type: normalizeType(type),
        name: name.trim(),
        used_memory: Number.isFinite(used) ? used : 0,
      });
    }
  }
  return entries;
}

/** Parse `--query-gpu=pci.bus_id,uuid --format=csv,noheader`. */
export function parseBusUuidMap(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [bus, uuid] = line.split(',').map((s) => s.trim());
    if (bus && uuid) map.set(normalizeBusId(bus), uuid);
  }
  return map;
}

/** Append `-q` entries missing from the compute-apps list (graphics-only
 *  clients). Entries on a GPU whose UUID is unknown are dropped, the hub
 *  could not attribute them to a card anyway. */
export function mergeQueryPids(
  procs: AgentGpuProcess[],
  listed: QueryPidsEntry[],
  uuidByBus: Map<string, string>,
  procRoot: string,
): void {
  const seen = new Set(procs.map((p) => `${p.pid}|${p.gpu_uuid}`));
  for (const e of listed) {
    const uuid = uuidByBus.get(e.busId);
    const key = `${e.pid}|${uuid}`;
    if (!uuid || seen.has(key)) continue;
    seen.add(key);
    procs.push(bareProcess(e.pid, displayName(e.name, e.pid, procRoot), uuid, e.used_memory));
  }
}

/** Row before enrichment (type, cmdline, CPU%, GPU%) in tick(). */
function bareProcess(pid: number, name: string, uuid: string, usedMiB: number): AgentGpuProcess {
  return {
    pid,
    process_name: name,
    gpu_uuid: uuid,
    used_memory: usedMiB,
    type: null,
    command: null,
    cpu_pct: null,
    gpu_pct: null,
  };
}
