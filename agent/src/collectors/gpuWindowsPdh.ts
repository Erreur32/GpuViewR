// Windows PDH-counter collector. Same `GpuCollectorHandle` contract as
// the nvidia/rocm/sysfs variants. Powers the "AMD/Intel GPU on Windows"
// case: there's no rocm-smi.exe and no equivalent vendor CLI, so we use
// the same Performance Data Helper counters that Task Manager surfaces.
//
// Approach: spawn a single long-running `powershell.exe -NoProfile`
// process. The script polls the language-INDEPENDENT WMI classes
// `Win32_PerfFormattedData_GPUPerformanceCounters_{GPUEngine,
// GPUAdapterMemory}` every TICK_MS, aggregates per-adapter (LUID +
// phys index), and writes one JSON line per snapshot to stdout. Node
// just parses each line and emits a GpuSample[]. Spawn cost is paid
// once at boot instead of every tick (~200-300 ms cold start on
// modern Windows).
//
// What's reported:
//   - utilization (highest engine util per adapter, matches Task Mgr)
//   - memory_used (DedicatedUsage, in MiB)
//   - name (best-effort from Win32_VideoController, by index order)
//   - memory_total (Win32_VideoController.AdapterRAM, in MiB)
//
// What's NULL on purpose: temperature, power, fan, clocks, PCIe — PDH
// doesn't expose them. NVIDIA users get the full picture via the
// nvidia-smi collector instead; this path is the universal fallback.
//
// AdapterRAM is a DWORD in WMI (4 GiB cap). Cards >4 GiB report 4096.
// Mentioned as a known limitation in the install messaging; a future
// pass can read HKLM\SYSTEM\...\Class\{4d36e968-...}\HardwareInformation
// .qwMemorySize (QWORD) for accurate totals.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { GpuSample } from '../../../server/services/parsers/nvidia.js';
import { nowTimestamp } from '../../../server/services/parsers/nvidia.js';
import { logger } from '../logger.js';

export type PdhGpuCollectorOptions = Readonly<{
  tickMs: number;
  onSample: (samples: GpuSample[]) => void;
}>;

export interface PdhGpuCollectorHandle {
  start(): void;
  stop(): void;
  available(): boolean;
}

// PowerShell script — kept inline so the agent stays a single-file ESM
// bundle. `${TICK_MS}` is the only substitution; the script is otherwise
// self-contained.
const PS_SCRIPT_TEMPLATE = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# One-shot lookup: name + AdapterRAM per video controller. Used to label
# adapters with something nicer than "GPU 0" and to attach a total VRAM
# figure. Ordering isn't guaranteed to match LUID order, but in practice
# Windows enumerates them in the same sequence — close enough for v1.
$controllers = @()
try {
  $controllers = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
    Where-Object { $_.PNPDeviceID -and $_.PNPDeviceID.StartsWith('PCI\') } |
    Sort-Object DeviceID |
    ForEach-Object {
      [pscustomobject]@{
        Name = $_.Name
        AdapterRAM = $_.AdapterRAM
        DriverVersion = $_.DriverVersion
      }
    })
} catch {}

function Emit-Snapshot {
  $engines = $null
  $mem = $null
  try { $engines = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue } catch {}
  try { $mem     = Get-CimInstance -ClassName Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue } catch {}

  if ((-not $engines) -and (-not $mem)) {
    Write-Output '{"adapters":[],"err":"no_counters"}'
    return
  }

  $byAdapter = @{}

  if ($engines) {
    foreach ($e in $engines) {
      if ($e.Name -match '^luid_([0-9a-fA-Fx_]+)_phys_(\d+)_eng_(\d+)_engtype_(\w+)$') {
        $key = "$($matches[1])_phys_$($matches[2])"
        if (-not $byAdapter.ContainsKey($key)) {
          $byAdapter[$key] = [ordered]@{ Util = 0; DedicatedMB = 0; SharedMB = 0; TotalMB = $null }
        }
        $u = [int]$e.UtilizationPercentage
        if ($u -gt $byAdapter[$key].Util) { $byAdapter[$key].Util = $u }
      }
    }
  }

  if ($mem) {
    foreach ($m in $mem) {
      if ($m.Name -match '^luid_([0-9a-fA-Fx_]+)_phys_(\d+)$') {
        $key = "$($matches[1])_phys_$($matches[2])"
        if (-not $byAdapter.ContainsKey($key)) {
          $byAdapter[$key] = [ordered]@{ Util = 0; DedicatedMB = 0; SharedMB = 0; TotalMB = $null }
        }
        $byAdapter[$key].DedicatedMB = [int]([math]::Round($m.DedicatedUsage / 1MB))
        $byAdapter[$key].SharedMB    = [int]([math]::Round($m.SharedUsage / 1MB))
      }
    }
  }

  $list = New-Object System.Collections.ArrayList
  $i = 0
  foreach ($key in ($byAdapter.Keys | Sort-Object)) {
    $a = $byAdapter[$key]
    $name = if ($i -lt $controllers.Count) { $controllers[$i].Name } else { "GPU $i" }
    $totalMB = $null
    if ($i -lt $controllers.Count -and $controllers[$i].AdapterRAM -and $controllers[$i].AdapterRAM -gt 0) {
      $totalMB = [int]([math]::Round($controllers[$i].AdapterRAM / 1MB))
    }
    $driver = if ($i -lt $controllers.Count) { $controllers[$i].DriverVersion } else { $null }
    [void]$list.Add([ordered]@{
      idx          = $i
      name         = $name
      util         = $a.Util
      dedicated_mb = $a.DedicatedMB
      shared_mb    = $a.SharedMB
      total_mb     = $totalMB
      driver       = $driver
    })
    $i++
  }

  $payload = @{ adapters = $list } | ConvertTo-Json -Compress -Depth 4
  Write-Output $payload
}

while ($true) {
  try { Emit-Snapshot } catch {
    $msg = $_.Exception.Message -replace '"','\"' -replace "[\r\n]+", ' '
    Write-Output ('{"adapters":[],"err":"' + $msg + '"}')
  }
  Start-Sleep -Milliseconds __TICK_MS__
}
`;

interface PsAdapter {
  idx: number;
  name: string;
  util: number;
  dedicated_mb: number;
  shared_mb: number;
  total_mb: number | null;
  driver: string | null;
}

interface PsPayload {
  adapters: PsAdapter[];
  err?: string;
}

export function createPdhGpuCollector(opts: PdhGpuCollectorOptions): PdhGpuCollectorHandle {
  let child: ChildProcessWithoutNullStreams | null = null;
  let started = false;
  let buf = '';
  let lastErrLogged = '';

  function handleLine(line: string): void {
    let payload: PsPayload;
    try {
      payload = JSON.parse(line);
    } catch (err) {
      logger.debug('gpu', `pdh: bad JSON (${(err as Error).message}): ${line.slice(0, 120)}`);
      return;
    }
    if (payload.err && payload.err !== lastErrLogged) {
      lastErrLogged = payload.err;
      logger.warn('gpu', `pdh: PowerShell reported: ${payload.err}`);
    }
    if (!Array.isArray(payload.adapters) || payload.adapters.length === 0) return;

    const { iso, epoch } = nowTimestamp();
    const samples: GpuSample[] = payload.adapters.map((a, i) => ({
      gpu_index: typeof a.idx === 'number' ? a.idx : i,
      name: a.name || `GPU ${i}`,
      uuid: null,
      driver_version: a.driver || null,
      temperature: 0,
      utilization: Number.isFinite(a.util) ? Math.round(a.util) : null,
      memory_used: Number.isFinite(a.dedicated_mb) ? a.dedicated_mb : 0,
      memory_total: Number.isFinite(a.total_mb as number) ? (a.total_mb as number) : null,
      power: 0,
      fan_speed: null,
      clock_graphics: null,
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
    }));

    if (samples.length > 0) opts.onSample(samples);
  }

  function spawnPs(): void {
    const script = PS_SCRIPT_TEMPLATE.replace('__TICK_MS__', String(opts.tickMs));
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', script,
      ], { windowsHide: true });
    } catch (err) {
      logger.error('gpu', `pdh: powershell spawn threw: ${(err as Error).message}`);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleLine(line);
        nl = buf.indexOf('\n');
      }
    });
    child.stderr.on('data', (d) => {
      const msg = d.toString('utf8').trim();
      if (msg) logger.debug('gpu', `pdh stderr: ${msg.slice(0, 200)}`);
    });
    child.on('error', (err) => logger.error('gpu', `pdh: powershell error: ${err.message}`));
    child.on('close', (code) => {
      child = null;
      if (started) {
        logger.warn('gpu', `pdh: powershell exited (code=${code}), respawning in 3 s`);
        setTimeout(() => { if (started) spawnPs(); }, 3_000).unref();
      }
    });
  }

  return {
    available(): boolean {
      // PDH GPU counters land in Win10 1709+. Older Windows boxes are
      // out of scope (the install.ps1 already requires Win10/Win11 with
      // winget). Returning true unconditionally on win32 means start()
      // is responsible for handling the (rare) spawn failure path.
      return process.platform === 'win32';
    },
    start(): void {
      if (started) return;
      started = true;
      logger.success('gpu', `PDH collector started (tick=${opts.tickMs}ms, Windows performance counters)`);
      spawnPs();
    },
    stop(): void {
      started = false;
      if (child) {
        try { child.kill(); } catch { /* already gone */ }
        child = null;
      }
      buf = '';
    },
  };
}
