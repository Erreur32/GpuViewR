// Synthetic GPU + process data for dev hosts without an NVIDIA GPU.
// Activated by MOCK_GPU=1 (see config.mockGpu). Two fake devices with
// fixed UUIDs so processCollector can reuse the UUID→index mapping.
import { randomInt } from 'node:crypto';
import type { GpuSample } from './gpuCollector.js';
import type { GpuProcess } from './processCollector.js';

// CSPRNG-backed [0, 1) float — used purely for cosmetic mock jitter,
// but routed through node:crypto so SonarCloud's S2245 hotspot stays
// clean without per-call NOSONAR comments. randomInt is plenty fast at
// our 1Hz tick (sub-microsecond per call).
function rand01(): number {
  return randomInt(0, 1_000_000) / 1_000_000;
}

interface FakeDevice {
  index: number;
  name: string;
  uuid: string;
  driver: string;
  memTotal: number;
  powerCap: number;
  pciBusId: string;
  pcieGen: number;
  pcieGenMax: number;
  pcieWidth: number;
  pcieWidthMax: number;
  // Phase offset so the two GPUs don't move in lockstep.
  phase: number;
}

const DEVICES: FakeDevice[] = [
  {
    index: 0,
    name: 'Mock RTX 4090',
    uuid: 'GPU-mock-0000-0000-0000-aaaaaaaaaaaa',
    driver: '550.54.14',
    memTotal: 24576,
    powerCap: 450,
    pciBusId: '00000000:01:00.0',
    pcieGen: 4, pcieGenMax: 4,
    pcieWidth: 16, pcieWidthMax: 16,
    phase: 0,
  },
  {
    index: 1,
    name: 'Mock RTX 3060',
    uuid: 'GPU-mock-1111-1111-1111-bbbbbbbbbbbb',
    driver: '550.54.14',
    memTotal: 12288,
    powerCap: 170,
    pciBusId: '00000000:02:00.0',
    // Intentional degraded link so the UI's "running below max" badge
    // is exercised in dev.
    pcieGen: 3, pcieGenMax: 4,
    pcieWidth: 8, pcieWidthMax: 16,
    phase: Math.PI / 2,
  },
];

const FAKE_PROCESSES: ReadonlyArray<{ pid: number; name: string; gpu: number }> = [
  { pid: 4242, name: 'python3', gpu: 0 },
  { pid: 4243, name: 'ollama', gpu: 0 },
  { pid: 4244, name: 'comfyui', gpu: 0 },
  { pid: 4245, name: 'blender', gpu: 1 },
  { pid: 4246, name: 'stable-diffusion', gpu: 1 },
];

function nowTimestamp(): { iso: string; epoch: number } {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { iso, epoch: Math.floor(d.getTime() / 1000) };
}

// Slow sinusoid + noise → smooth, plausible curves on the dashboard.
function wave(amp: number, base: number, periodSec: number, phase: number, jitter: number): number {
  const t = Date.now() / 1000;
  const s = Math.sin((t / periodSec) * 2 * Math.PI + phase);
  const n = (rand01() - 0.5) * 2 * jitter;
  return base + amp * s + n;
}

export function buildFakeSamples(): GpuSample[] {
  const { iso, epoch } = nowTimestamp();
  return DEVICES.map((d) => {
    const utilization = Math.max(0, Math.min(100, wave(40, 55, 90, d.phase, 5)));
    const temperature = Math.max(35, Math.min(85, wave(12, 62, 120, d.phase, 1.5)));
    const fan = Math.max(20, Math.min(100, wave(25, 50, 150, d.phase, 2)));
    const power = Math.max(20, Math.min(d.powerCap, wave(d.powerCap * 0.35, d.powerCap * 0.55, 90, d.phase, 4)));
    const memUsedRatio = Math.max(0.1, Math.min(0.95, wave(0.25, 0.45, 240, d.phase, 0.02)));
    const memUsed = Math.round(d.memTotal * memUsedRatio);
    const clockGr = Math.round(wave(300, 1700, 90, d.phase, 20));
    const clockMem = Math.round(wave(200, 9000, 90, d.phase, 30));
    return {
      gpu_index: d.index,
      name: d.name,
      uuid: d.uuid,
      driver_version: d.driver,
      temperature,
      utilization,
      memory_used: memUsed,
      memory_total: d.memTotal,
      power,
      fan_speed: fan,
      clock_graphics: clockGr,
      clock_memory: clockMem,
      pci_bus_id: d.pciBusId,
      pcie_gen_current: d.pcieGen,
      pcie_gen_max: d.pcieGenMax,
      pcie_width_current: d.pcieWidth,
      pcie_width_max: d.pcieWidthMax,
      // Synthesize asymmetric, non-trivially-different RX/TX so the UI
      // demonstrably shows two distinct values in mock mode (the bug
      // we just fixed was both tiles showing the same number).
      pcie_rx_kbps: Math.round(wave(50, 8000, 22, d.phase + 0.3, 200)),
      pcie_tx_kbps: Math.round(wave(20, 4000, 35, d.phase + 1.7, 200)),
      timestamp: iso,
      timestamp_epoch: epoch,
    };
  });
}

export function buildFakeProcesses(samples: GpuSample[]): GpuProcess[] {
  const memByGpu = new Map<number, number>();
  for (const s of samples) memByGpu.set(s.gpu_index, s.memory_used);
  const uuidByIndex = new Map<number, string>();
  for (const d of DEVICES) uuidByIndex.set(d.index, d.uuid);
  // Distribute the GPU's used memory among its fake processes, with a bit
  // of churn so the table updates between renders.
  const procsByGpu = new Map<number, GpuProcess[]>();
  for (const fp of FAKE_PROCESSES) {
    const list = procsByGpu.get(fp.gpu) ?? [];
    list.push({
      pid: fp.pid,
      process_name: fp.name,
      gpu_uuid: uuidByIndex.get(fp.gpu) ?? '',
      used_memory: 0,
      type: 'C',
      command: `/usr/bin/${fp.name} --mock-arg --port ${30000 + fp.pid % 1000}`,
      cpu_pct: Math.round(rand01() * 80 * 10) / 10,
      gpu_pct: Math.round(rand01() * 90),
    });
    procsByGpu.set(fp.gpu, list);
  }
  const out: GpuProcess[] = [];
  for (const [gpu, procs] of procsByGpu) {
    const total = memByGpu.get(gpu) ?? 0;
    const weights = procs.map(() => 0.5 + rand01());
    const sum = weights.reduce((a, b) => a + b, 0);
    procs.forEach((p, i) => {
      out.push({ ...p, used_memory: Math.round((weights[i] / sum) * total) });
    });
  }
  return out;
}
