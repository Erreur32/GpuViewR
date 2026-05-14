// Pure helpers for nvidia-smi parsing — extracted from gpuCollector.ts
// so the multi-host agent (Jalon 4) can reuse the exact same parsing
// logic without depending on the hub's collector singleton, DB, or bus.
// Importable from /agent and /server alike. No side effects, no I/O.

export const QUERY_FIELDS = [
  'index',
  'name',
  'uuid',
  'driver_version',
  'temperature.gpu',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'power.draw',
  'fan.speed',
  'clocks.gr',
  'clocks.mem',
  'pci.bus_id',
  'pcie.link.gen.current',
  'pcie.link.gen.max',
  'pcie.link.width.current',
  'pcie.link.width.max',
];

export interface GpuSample {
  gpu_index: number;
  name: string;
  uuid: string | null;
  driver_version: string | null;
  temperature: number;
  utilization: number | null;
  memory_used: number;
  memory_total: number | null;
  power: number;
  fan_speed: number | null;
  clock_graphics: number | null;
  clock_memory: number | null;
  pci_bus_id: string | null;
  pcie_gen_current: number | null;
  pcie_gen_max: number | null;
  pcie_width_current: number | null;
  pcie_width_max: number | null;
  pcie_rx_kbps: number | null;
  pcie_tx_kbps: number | null;
  timestamp: string;
  timestamp_epoch: number;
}

export interface PcieThroughput {
  rxKbps: number | null;
  txKbps: number | null;
}

export function num(v: string): number {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export function numOrNull(v: string): number | null {
  if (!v || v.trim() === '' || v.includes('N/A') || v.includes('Not Supported')) return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function nowTimestamp(): { iso: string; epoch: number } {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { iso, epoch: Math.floor(d.getTime() / 1000) };
}

export function normalizeBusId(id: string): string {
  return id.trim().toLowerCase();
}

export function matchKbps(block: string, re: RegExp): number | null {
  const m = re.exec(block);
  if (!m) return null;
  const raw = m[1].trim();
  if (!raw || /N\/?A|Not Supported|Not Active/i.test(raw)) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse `nvidia-smi -q` PCI sections into a map keyed by normalized PCI
 * bus id ("00000000:01:00.0", lower-case) AND by GPU block order
 * ("idx:N") as a fallback when the CSV `pci.bus_id` and the `-q` block
 * header use slightly different formats (real driver inconsistencies).
 */
export function parsePciThroughput(out: string): Map<string, PcieThroughput> {
  const result = new Map<string, PcieThroughput>();
  const blocks = out.split(/^GPU\s+/m).slice(1);
  blocks.forEach((block, blockIdx) => {
    const header = block.split('\n', 1)[0]?.trim();
    if (!header) return;
    const tx = matchKbps(block, /Tx\s+Throughput\s*:\s*([^\n]+)/i);
    const rx = matchKbps(block, /Rx\s+Throughput\s*:\s*([^\n]+)/i);
    const value: PcieThroughput = { txKbps: tx, rxKbps: rx };
    result.set(normalizeBusId(header), value);
    result.set(`idx:${blockIdx}`, value);
  });
  return result;
}
