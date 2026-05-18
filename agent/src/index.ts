// Agent bootstrap. The lifecycle is short; the rest is graceful
// shutdown plumbing and the MOCK_GPU dev path. Vendor selection
// happens once at boot (cf. resolveVendor): GPU_VENDOR=auto probes
// both binaries and prefers whichever responds first.

import { spawnSync } from 'node:child_process';
import { loadConfig, type AgentConfig, type GpuVendor } from './config.js';
import { logger } from './logger.js';
import { AGENT_VERSION, createTransport, INSTALL_MODE } from './transport.js';
import { createGpuCollector, type GpuCollectorHandle } from './collectors/gpu.js';
import { createRocmGpuCollector } from './collectors/gpuRocm.js';
import { createAmdgpuSysfsCollector } from './collectors/gpuAmdgpuSysfs.js';
import { createPdhGpuCollector } from './collectors/gpuWindowsPdh.js';
import { createProcessCollector, type ProcessCollectorHandle } from './collectors/processes.js';
import { createRocmProcessCollector } from './collectors/processesRocm.js';
import { buildMockSamples } from './mock.js';

const config = loadConfig();
const vendor = resolveVendor(config);

// AMD on Windows used to fail-fast (no rocm-smi exists on Windows).
// As of palier 2, AMD/Intel GPUs on Windows are supported through the
// PDH counter collector (gpuWindowsPdh.ts) — the same Performance
// Counters Task Manager surfaces. Limited telemetry (util + VRAM only,
// no temp/power/freq) but enough for the host to show up green on the
// hub with live numbers. NVIDIA on Windows still prefers nvidia-smi.exe.

// Banner line first: version + install mode are what people grep for in
// `systemctl status` / `docker logs` when figuring out which agent is
// stale. Keep it short and unmistakable.
logger.info('boot', `gpuviewr-agent v${AGENT_VERSION} (${INSTALL_MODE}) starting on node ${process.version}`);
logger.info('boot', `${config.hubs.length} hub${config.hubs.length === 1 ? '' : 's'}, label=${config.agentLabel ?? '(none)'}`);
for (const h of config.hubs) logger.info('boot', `  → ${h.url} (host_id=${h.hostId})`);
logger.info('boot', `Features: ${JSON.stringify(config.features)}`);
logger.info('boot', `GPU vendor: ${vendor} (configured: ${config.gpuVendor})`);
if (config.mockGpu) logger.warn('boot', 'MOCK_GPU=1 — synthetic GPU samples, no smi spawn');

const transport = createTransport(config);
transport.start();

let mockTimer: NodeJS.Timeout | null = null;
let gpuHandle: GpuCollectorHandle | null = null;
let processHandle: ProcessCollectorHandle | null = null;

if (config.features.gpu) {
  if (config.mockGpu) {
    const emit = () => transport.enqueueSample(buildMockSamples());
    emit();
    mockTimer = setInterval(emit, config.tickMs);
  } else {
    // Top-level await is fine in ESM/node22. Required for the AMD sysfs
    // path: discovery reads /sys asynchronously, and we want the boot
    // log line ("sysfs amdgpu / rocm-smi / nvidia") settled before we
    // start ticking.
    gpuHandle = await buildGpuCollector(vendor, config);
    if (!gpuHandle.available()) {
      const bin = vendor === 'amd' ? config.rocmSmiPath : config.nvidiaSmiPath;
      // Windows fallback: vendor-specific tool unavailable (e.g.
      // nvidia-smi.exe missing on an AMD/Intel box that resolveVendor
      // initially guessed as nvidia). Try the PDH collector — it works
      // for AMD, Intel, and even NVIDIA without driver tools. Replaces
      // the v0.6.9 soft-fail-and-emit-nothing path. On Linux a missing
      // smi is still a hard misconfiguration; the install.sh.tpl checks
      // earlier so reaching here implies the binary was uninstalled
      // after enrollment.
      if (process.platform === 'win32') {
        logger.warn(
          'boot',
          `${vendor} GPU tool unavailable at ${bin} — falling back to Windows PDH counters (util + VRAM only, no temp/power/freq)`,
        );
        gpuHandle = createPdhGpuCollector({
          tickMs: config.tickMs,
          onSample: (samples) => transport.enqueueSample(samples),
        });
        if (gpuHandle.available()) {
          gpuHandle.start();
        } else {
          logger.warn('boot', 'PDH collector unavailable too — agent will run without GPU samples');
          gpuHandle = null;
        }
      } else {
        logger.error('boot', `${vendor} smi not found at ${bin} — exiting (set MOCK_GPU=1 for dev)`);
        process.exit(1);
      }
    } else {
      gpuHandle.start();
    }
  }
}

// Process collector runs alongside the GPU collector when the smi
// binary is available. Skipped under MOCK_GPU=1 because synthetic
// samples don't have real PIDs to enrich. Also skipped on Windows —
// the collector reads /proc/<pid>/{stat,cmdline} which is Linux-only,
// and nvidia-smi pmon (used for GPU SM% per pid) isn't supported on
// the Windows WDDM driver model anyway.
if (process.platform === 'win32' && config.features.processes) {
  logger.warn('boot', 'process collector disabled on Windows (no /proc; nvidia-smi pmon unsupported). GPU samples will still stream normally.');
}
if (config.features.processes && !config.mockGpu && process.platform !== 'win32') {
  processHandle = buildProcessCollector(vendor, config);
  if (processHandle.available()) {
    processHandle.start();
  } else {
    logger.warn('boot', `process collector disabled (${vendor} smi unavailable)`);
    processHandle = null;
  }
}

// system/temps collectors are reserved for jalon 5+;
// today the agent ships GPU samples + (optionally) GPU processes.
// Other capabilities are negotiated in the hello frame so the hub
// knows what to expect.

function shutdown(signal: string): void {
  logger.info('boot', `Received ${signal}, shutting down...`);
  if (mockTimer) clearInterval(mockTimer);
  gpuHandle?.stop();
  processHandle?.stop();
  transport.stop();
  // Give the WS close() a moment to flush.
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- vendor resolution -----------------------------------------------

function smiResponds(bin: string): boolean {
  try {
    return spawnSync(bin, ['--version'], { timeout: 3_000 }).status === 0;
  } catch {
    return false;
  }
}

function resolveVendor(cfg: AgentConfig): 'nvidia' | 'amd' {
  if (cfg.gpuVendor === 'nvidia') return 'nvidia';
  if (cfg.gpuVendor === 'amd') return 'amd';
  // auto: probe both. Prefer nvidia when both exist (historical default,
  // and nvidia-smi exposes strictly more telemetry — PCIe RX/TX, pmon).
  if (cfg.mockGpu) return 'nvidia';
  const nvidia = smiResponds(cfg.nvidiaSmiPath);
  if (nvidia) return 'nvidia';
  const amd = smiResponds(cfg.rocmSmiPath);
  if (amd) return 'amd';
  // Neither found. On Windows, returning 'amd' routes the agent to the
  // PDH collector — universal (works for AMD/Intel iGPU/NVIDIA without
  // driver tools). On Linux, leave it as nvidia so the existing error
  // path (`nvidia-smi not found … exiting`) fires with its familiar
  // message rather than a confusing "no vendor".
  return process.platform === 'win32' ? 'amd' : 'nvidia';
}

async function buildGpuCollector(v: GpuVendor, cfg: AgentConfig): Promise<GpuCollectorHandle> {
  // On Windows, the "amd" branch is a misnomer — there is no rocm-smi
  // for Windows. We route it (and any non-NVIDIA Windows case) through
  // the PDH collector, which surfaces the same numbers Task Manager
  // shows. Works for AMD, Intel iGPU, even NVIDIA-without-smi.
  if (process.platform === 'win32' && v === 'amd') {
    return createPdhGpuCollector({
      tickMs: cfg.tickMs,
      onSample: (samples) => transport.enqueueSample(samples),
    });
  }
  if (v === 'amd') return buildAmdGpuCollector(cfg);
  return createGpuCollector({
    nvidiaSmiPath: cfg.nvidiaSmiPath,
    tickMs: cfg.tickMs,
    onSample: (samples) => transport.enqueueSample(samples),
  });
}

/** AMD backend selection. `sysfs` is preferred (~µs per tick vs
 *  ~80-130 ms for rocm-smi); `rocm-smi` stays as a fallback for hosts
 *  where /sys/class/drm is masked or empty (rare in containers with
 *  /dev/dri mapped, but possible on locked-down PaaS).
 *
 *  GPU_BACKEND=auto (default): probe sysfs, fall through to rocm-smi
 *  if no amdgpu card was discovered.
 *  GPU_BACKEND=sysfs: force sysfs, never spawn rocm-smi for samples.
 *  GPU_BACKEND=rocm-smi: legacy path (one rocm-smi spawn per tick). */
async function buildAmdGpuCollector(cfg: AgentConfig): Promise<GpuCollectorHandle> {
  const onSample = (samples: Parameters<typeof transport.enqueueSample>[0]) =>
    transport.enqueueSample(samples);

  if (cfg.gpuBackend === 'rocm-smi') {
    logger.info('boot', 'AMD backend: rocm-smi (forced via GPU_BACKEND=rocm-smi)');
    return createRocmGpuCollector({
      rocmSmiPath: cfg.rocmSmiPath,
      tickMs: cfg.tickMs,
      onSample,
    });
  }

  const sysfs = createAmdgpuSysfsCollector({
    sysClassDrm: cfg.sysClassDrm,
    tickMs: cfg.tickMs,
    onSample,
  });
  const cards = await sysfs.discover();
  if (cards > 0) {
    logger.info('boot', `AMD backend: sysfs (${cards} card${cards === 1 ? '' : 's'} via ${cfg.sysClassDrm})`);
    return sysfs;
  }

  if (cfg.gpuBackend === 'sysfs') {
    // Forced sysfs but no card → return the empty handle so the caller's
    // available()===false path takes over with the standard "smi not
    // found" error. Avoids a silent no-op.
    logger.error('boot', `GPU_BACKEND=sysfs but no amdgpu card found under ${cfg.sysClassDrm}`);
    return sysfs;
  }

  logger.warn('boot', `AMD backend: sysfs found 0 cards under ${cfg.sysClassDrm}, falling back to rocm-smi`);
  return createRocmGpuCollector({
    rocmSmiPath: cfg.rocmSmiPath,
    tickMs: cfg.tickMs,
    onSample,
  });
}

function buildProcessCollector(v: GpuVendor, cfg: AgentConfig): ProcessCollectorHandle {
  if (v === 'amd') {
    return createRocmProcessCollector({
      rocmSmiPath: cfg.rocmSmiPath,
      tickMs: cfg.processesTickMs,
      hostProc: cfg.hostProc,
      onSnapshot: (snap) => transport.enqueueProcesses(snap.processes),
    });
  }
  return createProcessCollector({
    nvidiaSmiPath: cfg.nvidiaSmiPath,
    tickMs: cfg.processesTickMs,
    hostProc: cfg.hostProc,
    onSnapshot: (snap) => transport.enqueueProcesses(snap.processes),
  });
}
