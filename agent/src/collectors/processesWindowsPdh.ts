// Windows GPU-process collector, same `ProcessCollectorHandle` contract
// as the nvidia/rocm variants. The Linux collectors lean on /proc and
// `nvidia-smi pmon`, neither exists on Windows (pmon is unsupported
// under WDDM), so this one reads the per-process PDH counters Task
// Manager uses, through the language-independent WMI classes:
//
//   GPUEngine         pid_<pid>_luid_<hi>_<lo>_phys_<n>_eng_<e>_engtype_<t>
//   GPUProcessMemory  pid_<pid>_luid_<hi>_<lo>_phys_<n>   (DedicatedUsage)
//
// That covers every vendor (NVIDIA, AMD, Intel) and gives a real
// per-pid GPU% plus dedicated VRAM, which nvidia-smi can't report in
// WDDM mode. Name, cumulative CPU time and command line come from
// Get-Process / Win32_Process in the same PowerShell loop.
//
// Rows are keyed by adapter ("luid_…_phys_<n>"). When the GPU samples
// come from the PDH collector the uuid is derived from that key; when
// they come from nvidia-smi (real GPU-xxxx uuids), the adapter → uuid
// mapping is learnt by matching pids against `nvidia-smi -q -d PIDS`.

import { execFile } from 'node:child_process';
import { win32 } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import { createPsLoop } from './_psLoop.js';
import { pdhAdapterUuid } from './gpuWindowsPdh.js';
import { classifyLLM, type LLMResolvers } from './llmClassifier.js';
import {
  parseBusUuidMap,
  parseQueryPids,
  type AgentGpuProcess,
  type GpuProcessType,
  type ProcessCollectorHandle,
  type ProcessSnapshot,
} from './processes.js';

const execFileAsync = promisify(execFile);

export type PdhProcessCollectorOptions = Readonly<{
  tickMs: number;
  /** Set when GPU samples come from nvidia-smi: processes are then
   *  attributed to the real NVIDIA uuids instead of PDH adapter keys. */
  nvidiaSmiPath?: string;
  onSnapshot: (snap: ProcessSnapshot) => void;
  llmResolvers?: LLMResolvers;
}>;

const MIN_TICK_MS = 2_000;
// Retry window for the adapter → NVIDIA uuid mapping when an adapter
// stays unmapped (iGPU, Basic Render Driver: those never map).
const NVIDIA_MAP_TTL_MS = 60_000;

const PS_SCRIPT_TEMPLATE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# pid -> command line. Win32_Process is the slow part of the loop, so
# each pid is looked up once and dropped when it leaves the GPU.
$cmdCache = @{}

function Emit-Snapshot {
  $engines = $null
  $mem = $null
  try { $engines = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue } catch {}
  try { $mem     = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -ErrorAction SilentlyContinue } catch {}

  if ((-not $engines) -and (-not $mem)) {
    Write-Output '{"procs":[],"err":"no_counters"}'
    return
  }

  $rows = @{}
  if ($engines) {
    foreach ($e in $engines) {
      if ($e.Name -match '^pid_(\d+)_(luid_0x[0-9a-fA-F]+_0x[0-9a-fA-F]+_phys_\d+)_eng_\d+_engtype_(.*)$') {
        $k = "$($matches[1])|$($matches[2])"
        $engType = $matches[3]
        if (-not $rows.ContainsKey($k)) {
          $rows[$k] = [ordered]@{ Pid = [int]$matches[1]; Key = $matches[2]; Util = 0; DedBytes = 0; G = $false; C = $false }
        }
        $u = [int]$e.UtilizationPercentage
        if ($u -gt $rows[$k].Util) { $rows[$k].Util = $u }
        if ($u -gt 0) {
          if ($engType -match '^(3D|Graphics)') { $rows[$k].G = $true }
          elseif ($engType -match '^(Compute|Cuda)') { $rows[$k].C = $true }
        }
      }
    }
  }

  if ($mem) {
    foreach ($m in $mem) {
      if ($m.Name -match '^pid_(\d+)_(luid_0x[0-9a-fA-F]+_0x[0-9a-fA-F]+_phys_\d+)$') {
        $k = "$($matches[1])|$($matches[2])"
        if (-not $rows.ContainsKey($k)) {
          $rows[$k] = [ordered]@{ Pid = [int]$matches[1]; Key = $matches[2]; Util = 0; DedBytes = 0; G = $false; C = $false }
        }
        $rows[$k].DedBytes = [int64]$m.DedicatedUsage
      }
    }
  }

  # Same population as Task Manager's GPU columns: anything holding
  # dedicated VRAM or currently busy on an engine. pid 0 is the idle
  # pseudo-process.
  $active = @($rows.Values | Where-Object { $_.Pid -ne 0 -and ($_.Util -gt 0 -or $_.DedBytes -gt 0) })
  $pids = @($active | ForEach-Object { $_.Pid } | Sort-Object -Unique)

  $info = @{}
  if ($pids.Count -gt 0) {
    foreach ($p in @(Get-Process -Id $pids -ErrorAction SilentlyContinue)) {
      $path = $null
      $cpu = $null
      try { $path = $p.Path } catch {}
      try { $cpu = $p.TotalProcessorTime.TotalSeconds } catch {}
      $info[[int]$p.Id] = @{ Name = $p.ProcessName; Path = $path; Cpu = $cpu }
    }
    $missing = @($pids | Where-Object { -not $cmdCache.ContainsKey($_) })
    if ($missing.Count -gt 0) {
      $filter = ($missing | ForEach-Object { "ProcessId=$_" }) -join ' OR '
      try {
        foreach ($w in @(Get-CimInstance -ClassName Win32_Process -Filter $filter -Property ProcessId,CommandLine -ErrorAction SilentlyContinue)) {
          $cmdCache[[int]$w.ProcessId] = [string]$w.CommandLine
        }
      } catch {}
      # Unreadable or already gone: remember the miss, don't re-query every tick.
      foreach ($id in $missing) { if (-not $cmdCache.ContainsKey($id)) { $cmdCache[$id] = '' } }
    }
  }
  foreach ($id in @($cmdCache.Keys)) { if ($pids -notcontains $id) { $cmdCache.Remove($id) } }

  $list = New-Object System.Collections.ArrayList
  foreach ($r in $active) {
    $i = $info[$r.Pid]
    [void]$list.Add([ordered]@{
      pid    = $r.Pid
      key    = $r.Key
      util   = $r.Util
      ded_mb = [int]([math]::Round($r.DedBytes / 1MB))
      g      = $r.G
      c      = $r.C
      name   = if ($i) { $i.Name } else { $null }
      path   = if ($i) { $i.Path } else { $null }
      cpu_s  = if ($i) { $i.Cpu } else { $null }
      cmd    = $cmdCache[$r.Pid]
    })
  }

  $payload = @{ procs = $list } | ConvertTo-Json -Compress -Depth 4
  Write-Output $payload
}

while ($true) {
  try { Emit-Snapshot } catch {
    $msg = $_.Exception.Message -replace '"','\"' -replace "[\r\n]+", ' '
    Write-Output ('{"procs":[],"err":"' + $msg + '"}')
  }
  Start-Sleep -Milliseconds __TICK_MS__
}
`;

/** One (pid, adapter) row as printed by the PowerShell loop. */
export interface PdhProcRow {
  pid: number;
  key: string;
  util: number;
  ded_mb: number;
  g: boolean;
  c: boolean;
  name: string | null;
  path: string | null;
  cpu_s: number | null;
  cmd: string | null;
}

interface PdhProcPayload {
  procs: PdhProcRow[];
  err?: string;
}

/** Parse one JSON line; null when it isn't valid JSON. */
export function parsePdhProcLine(line: string): PdhProcPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { procs?: unknown; err?: unknown };
  const procs = Array.isArray(obj.procs)
    ? obj.procs.filter((p): p is PdhProcRow =>
        !!p && typeof p === 'object' && Number.isFinite((p as PdhProcRow).pid) && typeof (p as PdhProcRow).key === 'string')
    : [];
  return { procs, ...(typeof obj.err === 'string' ? { err: obj.err } : {}) };
}

/** Executable basename for the name column, like nvidia-smi rows. */
export function pdhDisplayName(row: Pick<PdhProcRow, 'path' | 'name'>): string {
  if (row.path) return win32.basename(row.path);
  if (row.name) return `${row.name}.exe`;
  return 'unknown';
}

/** Engine-based type for this tick; null when no 3D/compute engine was busy. */
export function pdhType(row: Pick<PdhProcRow, 'g' | 'c'>): GpuProcessType {
  if (row.g && row.c) return 'G+C';
  if (row.g) return 'G';
  if (row.c) return 'C';
  return null;
}

/**
 * Map PDH adapter keys to NVIDIA uuids from pid overlap. A process
 * drawing on two adapters (dwm.exe, browsers) votes for both, so each
 * uuid goes to the adapter with the most matching pids, and each
 * adapter gets at most one uuid. Unmatched adapters (iGPU) stay absent.
 */
export function matchAdaptersToUuids(
  rows: ReadonlyArray<Pick<PdhProcRow, 'pid' | 'key'>>,
  uuidByPid: ReadonlyMap<number, string>,
): Map<string, string> {
  const votes = new Map<string, number>();
  for (const r of rows) {
    const uuid = uuidByPid.get(r.pid);
    if (!uuid) continue;
    const k = `${r.key}\n${uuid}`;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const result = new Map<string, string>();
  const usedUuids = new Set<string>();
  for (const [k] of ranked) {
    const [key, uuid] = k.split('\n');
    if (result.has(key) || usedUuids.has(uuid)) continue;
    result.set(key, uuid);
    usedUuids.add(uuid);
  }
  return result;
}

interface NvidiaAdapterMap {
  uuidFor(key: string): string | null;
  refresh(rows: ReadonlyArray<PdhProcRow>): Promise<void>;
}

function createNvidiaAdapterMap(nvidiaSmiPath: string): NvidiaAdapterMap {
  let byKey = new Map<string, string>();
  let refreshedAt = 0;

  async function smi(args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(nvidiaSmiPath, args, { timeout: 10_000, windowsHide: true });
      return stdout;
    } catch (err) {
      logger.debug('proc', `nvidia-smi ${args[0]} failed: ${(err as Error).message}`);
      return null;
    }
  }

  return {
    uuidFor: (key) => byKey.get(key) ?? null,
    async refresh(rows): Promise<void> {
      if (rows.every((r) => byKey.has(r.key))) return;
      if (Date.now() - refreshedAt < NVIDIA_MAP_TTL_MS) return;
      refreshedAt = Date.now();
      const [busOut, pidsOut] = await Promise.all([
        smi(['--query-gpu=pci.bus_id,uuid', '--format=csv,noheader']),
        smi(['-q', '-d', 'PIDS']),
      ]);
      if (busOut === null || pidsOut === null) return;
      const uuidByBus = parseBusUuidMap(busOut);
      const uuidByPid = new Map<number, string>();
      for (const e of parseQueryPids(pidsOut)) {
        const uuid = uuidByBus.get(e.busId);
        if (uuid) uuidByPid.set(e.pid, uuid);
      }
      byKey = matchAdaptersToUuids(rows, uuidByPid);
    },
  };
}

export function createPdhProcessCollector(opts: PdhProcessCollectorOptions): ProcessCollectorHandle {
  const tickMs = Math.max(opts.tickMs, MIN_TICK_MS);
  const nvidiaMap = opts.nvidiaSmiPath ? createNvidiaAdapterMap(opts.nvidiaSmiPath) : null;
  const uuidFor = (key: string): string | null => (nvidiaMap ? nvidiaMap.uuidFor(key) : pdhAdapterUuid(key));
  // Engines only flag a type while busy; keep the last one seen so an
  // idle row doesn't flicker between "G" and blank.
  const lastType = new Map<number, GpuProcessType>();
  const prevCpu = new Map<number, { cpuS: number; ts: number }>();
  let lastErrLogged = '';
  let inflight = false;

  function cpuPct(pid: number, cpuS: number | null, now: number): number | null {
    if (cpuS === null || !Number.isFinite(cpuS)) return null;
    const before = prevCpu.get(pid);
    prevCpu.set(pid, { cpuS, ts: now });
    if (!before) return null;
    const dt = (now - before.ts) / 1000;
    const dCpu = cpuS - before.cpuS;
    if (dt <= 0 || dCpu < 0) return null;
    return Math.round((dCpu / dt) * 100 * 10) / 10;
  }

  async function handleLine(line: string): Promise<void> {
    const payload = parsePdhProcLine(line);
    if (!payload) {
      logger.debug('proc', `pdh: bad JSON: ${line.slice(0, 120)}`);
      return;
    }
    if (payload.err && payload.err !== lastErrLogged) {
      lastErrLogged = payload.err;
      logger.warn('proc', `pdh: PowerShell reported: ${payload.err}`);
    }
    if (nvidiaMap) await nvidiaMap.refresh(payload.procs);

    const now = Date.now();
    const alive = new Set<number>();
    // A pid listed on two adapters is sampled once and shown on both rows.
    const cpuThisTick = new Map<number, number | null>();
    const processes: AgentGpuProcess[] = [];
    for (const row of payload.procs) {
      const uuid = uuidFor(row.key);
      if (!uuid) continue; // adapter the hub has no card for
      alive.add(row.pid);
      const type = pdhType(row) ?? lastType.get(row.pid) ?? null;
      if (type) lastType.set(row.pid, type);
      const command = row.cmd || null;
      const llm = classifyLLM(command, opts.llmResolvers);
      if (!cpuThisTick.has(row.pid)) cpuThisTick.set(row.pid, cpuPct(row.pid, row.cpu_s, now));
      processes.push({
        pid: row.pid,
        process_name: pdhDisplayName(row),
        gpu_uuid: uuid,
        used_memory: Number.isFinite(row.ded_mb) ? row.ded_mb : 0,
        type,
        command,
        cpu_pct: cpuThisTick.get(row.pid) ?? null,
        gpu_pct: Number.isFinite(row.util) ? row.util : null,
        llm_runtime: llm.runtime,
        llm_model: llm.model,
      });
    }
    for (const pid of prevCpu.keys()) if (!alive.has(pid)) prevCpu.delete(pid);
    for (const pid of lastType.keys()) if (!alive.has(pid)) lastType.delete(pid);
    opts.onSnapshot({ tsEpoch: Math.floor(now / 1000), processes });
  }

  const loop = createPsLoop({
    tag: 'proc',
    label: 'pdh',
    script: PS_SCRIPT_TEMPLATE.replace('__TICK_MS__', String(tickMs)),
    onLine: (line) => {
      // Drop a tick rather than queue it while the nvidia-smi lookup runs.
      if (inflight) return;
      inflight = true;
      void handleLine(line).finally(() => { inflight = false; });
    },
  });

  return {
    available(): boolean {
      return process.platform === 'win32';
    },
    start(): void {
      const source = nvidiaMap ? 'mapped to nvidia-smi uuids' : 'PDH adapters';
      logger.success('proc', `PDH process collector started (tick=${tickMs}ms, ${source})`);
      loop.start();
    },
    stop(): void {
      loop.stop();
    },
  };
}
