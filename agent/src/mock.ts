// Synthetic samples for dev hosts without an NVIDIA GPU. Activated
// by MOCK_GPU=1. Two fake devices with fixed UUIDs, randomized
// utilization/temp on each call. Mirrors the hub's mockGpu.ts shape
// — kept minimal here since the agent doesn't need process names.

import { randomInt } from 'node:crypto';
import { nowTimestamp, type GpuSample } from '../../server/services/parsers/nvidia.js';

function frand(): number {
  return randomInt(0, 1_000_000) / 1_000_000;
}

const MOCK_CARDS: Array<Pick<GpuSample, 'gpu_index' | 'name' | 'uuid' | 'driver_version' | 'memory_total' | 'pci_bus_id'>> = [
  { gpu_index: 0, name: 'Mock RTX 4090', uuid: 'GPU-mock-00000000-0000-0000-0000-000000000000', driver_version: '550.54-mock', memory_total: 24576, pci_bus_id: '00000000:01:00.0' },
  { gpu_index: 1, name: 'Mock RTX 3060', uuid: 'GPU-mock-11111111-1111-1111-1111-111111111111', driver_version: '550.54-mock', memory_total: 12288, pci_bus_id: '00000000:02:00.0' },
];

export function buildMockSamples(): GpuSample[] {
  const { iso, epoch } = nowTimestamp();
  return MOCK_CARDS.map((c) => ({
    ...c,
    temperature: 50 + Math.round(frand() * 30),
    utilization: Math.round(frand() * 100),
    memory_used: Math.round(frand() * (c.memory_total ?? 1024)),
    power: 80 + Math.round(frand() * 250),
    fan_speed: Math.round(frand() * 100),
    clock_graphics: 1500 + Math.round(frand() * 600),
    clock_memory: 8000 + Math.round(frand() * 1500),
    pcie_gen_current: 4,
    pcie_gen_max: 4,
    pcie_width_current: 16,
    pcie_width_max: 16,
    pcie_rx_kbps: Math.round(frand() * 100_000),
    pcie_tx_kbps: Math.round(frand() * 100_000),
    timestamp: iso,
    timestamp_epoch: epoch,
  }));
}
