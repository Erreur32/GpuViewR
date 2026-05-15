// Dev-only synthetic agent. Activated by MOCK_GPU=1 so contributors
// can exercise the multi-host path (Dashboard host selector, agent
// process table, hosts list) without spinning up a real agent.
//
// What it does each tick:
//   1. Builds fake GPU samples for a fixed `mock-agent-1` host, using
//      distinct UUIDs/PCI bus IDs so they don't collide with the local
//      mock GPUs.
//   2. Emits them on metricsBus so gpuStreamWS forwards them to the
//      browser exactly like a real agent would.
//   3. Upserts the corresponding gpu_devices rows.
//   4. Synthesises per-process VRAM distribution and pushes the snapshot
//      into agentProcessStore.
//   5. Heartbeats hosts.last_seen so the watchdog keeps the host online.

import { HostsRepo } from '../database/models/Host.js';
import { GpuDeviceRepository } from '../database/models/GpuMetric.js';
import { metricsBus } from './_metricsBus.js';
import { agentProcessStore } from './agentProcessStore.js';
import { nowTimestamp, type GpuSample } from './_nvidiaParsers.js';
import type { GpuProcess } from './processCollector.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { rand01, sweep } from './_mockHelpers.js';

export const MOCK_AGENT_HOST_ID = 'mock-agent-1';

interface FakeAgentDevice {
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
  phase: number;
}

const DEVICES: FakeAgentDevice[] = [
  {
    index: 0,
    name: 'Mock A100 (agent)',
    uuid: 'GPU-mockagt-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    driver: '550.54.14',
    memTotal: 40960,
    powerCap: 400,
    pciBusId: '00000000:0a:00.0',
    pcieGen: 4, pcieGenMax: 4,
    pcieWidth: 16, pcieWidthMax: 16,
    phase: Math.PI / 3,
  },
];

const FAKE_PROCESSES: ReadonlyArray<{ pid: number; name: string; gpu: number }> = [
  { pid: 9001, name: 'pytorch-train', gpu: 0 },
  { pid: 9002, name: 'jupyter-kernel', gpu: 0 },
  { pid: 9003, name: 'ray-worker', gpu: 0 },
];

function buildSamples(): GpuSample[] {
  const { iso, epoch } = nowTimestamp();
  return DEVICES.map((d) => ({
    gpu_index: d.index,
    name: d.name,
    uuid: d.uuid,
    driver_version: d.driver,
    temperature: sweep(40, 80, 50, d.phase),
    utilization: sweep(10, 95, 30, d.phase),
    memory_used: Math.round(d.memTotal * sweep(0.1, 0.8, 60, d.phase)),
    memory_total: d.memTotal,
    power: sweep(50, d.powerCap, 35, d.phase),
    fan_speed: sweep(20, 90, 50, d.phase),
    clock_graphics: Math.round(1400 + sweep(0, 400, 90, d.phase)),
    clock_memory: Math.round(8800 + sweep(0, 200, 90, d.phase)),
    pci_bus_id: d.pciBusId,
    pcie_gen_current: d.pcieGen,
    pcie_gen_max: d.pcieGenMax,
    pcie_width_current: d.pcieWidth,
    pcie_width_max: d.pcieWidthMax,
    pcie_rx_kbps: Math.round(sweep(1000, 50_000, 25, d.phase)),
    pcie_tx_kbps: Math.round(sweep(1000, 50_000, 40, d.phase + 1.1)),
    timestamp: iso,
    timestamp_epoch: epoch,
  }));
}

function buildProcesses(samples: GpuSample[]): GpuProcess[] {
  const uuidByIndex = new Map<number, string>();
  for (const d of DEVICES) uuidByIndex.set(d.index, d.uuid);
  const memByGpu = new Map<number, number>();
  for (const s of samples) memByGpu.set(s.gpu_index, s.memory_used);
  // One slice of GPU VRAM per process, jittered each tick.
  const procsByGpu = new Map<number, GpuProcess[]>();
  for (const fp of FAKE_PROCESSES) {
    const list = procsByGpu.get(fp.gpu) ?? [];
    list.push({
      pid: fp.pid,
      process_name: fp.name,
      gpu_uuid: uuidByIndex.get(fp.gpu) ?? '',
      used_memory: 0,
      type: 'C',
      command: `/usr/bin/${fp.name} --mock --rank ${fp.pid % 8}`,
      cpu_pct: Math.round(rand01() * 70 * 10) / 10,
      gpu_pct: Math.round(rand01() * 95),
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

class MockAgentSeeder {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (!config.mockGpu) return;
    if (this.timer) return;
    // Idempotent insert — running dev:mock twice in a row must not
    // duplicate the row.
    if (!HostsRepo.findById(MOCK_AGENT_HOST_ID)) {
      HostsRepo.insert({
        id: MOCK_AGENT_HOST_ID,
        label: 'Mock Agent',
        hostname: 'mock-agent.local',
        kind: 'agent',
        token_hash: null,
        capabilities: JSON.stringify({ gpu: true, system: false, temps: false, processes: true }),
        agent_version: '0.3.0-mock',
        status: 'online',
      });
      logger.info('mockAgent', `Seeded synthetic host ${MOCK_AGENT_HOST_ID}`);
    }
    logger.warn('mockAgent', `Mock agent seeder started (tick=${config.gpuTickMs}ms) — synthetic data`);
    this.tick();
    this.timer = setInterval(() => this.tick(), config.gpuTickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const samples = buildSamples();
    for (const s of samples) {
      try {
        GpuDeviceRepository.upsert({
          host_id: MOCK_AGENT_HOST_ID,
          gpu_index: s.gpu_index,
          name: s.name,
          uuid: s.uuid,
          memory_total: s.memory_total,
          driver_version: s.driver_version,
        });
      } catch (err) {
        logger.debug('mockAgent', `device upsert failed: ${(err as Error).message}`);
      }
    }
    metricsBus.emit('sample', { host_id: MOCK_AGENT_HOST_ID, samples });
    agentProcessStore.set(MOCK_AGENT_HOST_ID, {
      ts: Math.floor(Date.now() / 1000),
      processes: buildProcesses(samples),
    });
    try {
      HostsRepo.markSeen(MOCK_AGENT_HOST_ID);
    } catch { /* best-effort */ }
  }
}

export const mockAgentSeeder = new MockAgentSeeder();
