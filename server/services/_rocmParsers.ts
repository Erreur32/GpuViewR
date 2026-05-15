// Pure helpers for rocm-smi --json parsing. Sibling of _nvidiaParsers.ts;
// same role: shared between the hub and the agent so a single parse path
// covers both. No I/O, no side effects.
//
// rocm-smi JSON shape varies by command:
//   - Info commands (--showmeminfo/--showclocks/--showtemp/--showuse/...)
//     emit { "card0": {...}, "card1": {...}, "system": { "Driver version": "..." } }.
//     Keys inside each card are human strings with units in parens
//     ("VRAM Total Memory (B)", "GPU use (%)", etc.).
//   - --showpids emits { "system": { "PID<n>": "<csv-string>", ... } }.
//     The value is a single comma-separated string, not a nested object:
//     "process_name, gpu_count, vram_bytes, sdma_bytes, cu_occupancy".
//     Empty (no GPU procs) → stdout is empty, exit 0, warning on stderr.
//
// AMD doesn't expose a globally-unique GPU UUID like NVIDIA's. We synth
// one from the PCI bus (always present, stable across reboots on a given
// box): `ROCm-${normalizedBus}`. Used as the gpu_uuid in samples AND
// process snapshots so the UI's `${pid}-${gpu_uuid}` React key stays stable.

import { nowTimestamp, type GpuSample } from './_nvidiaParsers.js';

export interface RocmCard {
  index: number;
  raw: Record<string, string>;
}

export interface RocmInfo {
  cards: RocmCard[];
  driverVersion: string | null;
}

export interface RocmProcess {
  pid: number;
  process_name: string;
  vram_used_bytes: number;
  sdma_used_bytes: number;
  cu_occupancy: number | null;
  gpu_count: number;
}

// Device ID → commercial name. Lookup is preferred over rocm-smi's
// "Card Model" / "Device Name" fields because the driver often returns
// "N/A" or just the raw hex ID for newer parts. Extend as needed —
// PRs welcome. Source: amdgpu kernel driver + AMD public listings.
const DEVICE_NAMES: Record<string, string> = {
  '0x1586': 'AMD Radeon 8060S (Strix Halo)',
  '0x164e': 'AMD Raphael iGPU',
  '0x744c': 'AMD Radeon RX 7900 series',
  '0x747e': 'AMD Radeon RX 7800/7700 XT',
  '0x7480': 'AMD Radeon RX 7600',
  '0x73a5': 'AMD Radeon RX 6950 XT',
  '0x73bf': 'AMD Radeon RX 6800/6900 XT',
  '0x73df': 'AMD Radeon RX 6700 XT',
  '0x73ff': 'AMD Radeon RX 6600/6650 XT',
};

export function rocmDeviceName(deviceId: string | undefined, gfxVersion: string | undefined): string {
  if (deviceId) {
    const hit = DEVICE_NAMES[deviceId.toLowerCase()];
    if (hit) return hit;
  }
  if (gfxVersion && gfxVersion.startsWith('gfx')) return `AMD GPU (${gfxVersion})`;
  return 'AMD GPU';
}

export function rocmUuidFromBus(pciBus: string | undefined): string {
  if (!pciBus) return 'ROCm-unknown';
  const safe = pciBus.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `ROCm-${safe}`;
}

/**
 * Parse a rocm-smi --json info dump (--showmeminfo vram --showclocks
 * --showtemp --showuse --showpower --showid --showbus --showdriverversion).
 * Returns an empty RocmInfo if the JSON is malformed — the collector
 * decides whether that's a "no data this tick" or a hard error.
 */
export function parseRocmInfo(jsonText: string): RocmInfo {
  if (!jsonText || !jsonText.trim()) return { cards: [], driverVersion: null };
  let parsed: Record<string, Record<string, string>>;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { cards: [], driverVersion: null };
  }
  const cards: RocmCard[] = [];
  let driverVersion: string | null = null;
  for (const [key, val] of Object.entries(parsed)) {
    if (key === 'system') {
      driverVersion = val?.['Driver version'] || null;
      continue;
    }
    const m = /^card(\d+)$/.exec(key);
    if (!m) continue;
    cards.push({ index: Number.parseInt(m[1], 10), raw: val || {} });
  }
  cards.sort((a, b) => a.index - b.index);
  return { cards, driverVersion };
}

/**
 * Strip "(605Mhz)" → 605, returning null on N/A or unparsable input.
 * rocm-smi wraps clock readings in parens with a trailing "Mhz" suffix
 * for some reason; both fields appear like `"sclk clock speed:": "(605Mhz)"`.
 */
export function parseRocmClock(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /\(?\s*([\d.]+)\s*MHz\s*\)?/i.exec(raw);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseFloatOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed || /^N\/?A$/i.test(trimmed)) return null;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

function bytesToMiB(raw: string | undefined): number | null {
  const n = parseFloatOrNull(raw);
  if (n === null) return null;
  return Math.floor(n / 1048576);
}

/**
 * Map a single RocmCard into the shared GpuSample shape. Fields that
 * have no ROCm equivalent (PCIe gen/width/RX-TX, memory clock on APUs,
 * fan on APUs) come back null — the type already permits that, and the
 * UI renders "—" for null values.
 */
export function mapRocmCardToSample(
  card: RocmCard,
  driverVersion: string | null,
  ts: { iso: string; epoch: number } = nowTimestamp(),
): GpuSample {
  const r = card.raw;
  const pciBus = r['PCI Bus'];
  const name = rocmDeviceName(r['Device ID'], r['GFX Version']);
  const uuid = rocmUuidFromBus(pciBus);

  const memTotalMiB = bytesToMiB(r['VRAM Total Memory (B)']);
  const memUsedMiB = bytesToMiB(r['VRAM Total Used Memory (B)']) ?? 0;

  // Strix Halo APUs report no fan, no memory clock, no PCIe RX/TX,
  // no PCIe gen/width — null across the board. Discrete Radeon cards
  // surface a fan but no rocm-smi field we depend on, so we leave it
  // null until a separate ticket adds --showfan parsing.
  return {
    gpu_index: card.index,
    name,
    uuid,
    driver_version: driverVersion,
    temperature: parseFloatOrNull(r['Temperature (Sensor edge) (C)']) ?? 0,
    utilization: parseFloatOrNull(r['GPU use (%)']),
    memory_used: memUsedMiB,
    memory_total: memTotalMiB,
    power: parseFloatOrNull(r['Current Socket Graphics Package Power (W)'])
        ?? parseFloatOrNull(r['Average Graphics Package Power (W)'])
        ?? 0,
    fan_speed: null,
    clock_graphics: parseRocmClock(r['sclk clock speed:']),
    clock_memory: parseRocmClock(r['mclk clock speed:']),
    pci_bus_id: pciBus || null,
    pcie_gen_current: null,
    pcie_gen_max: null,
    pcie_width_current: null,
    pcie_width_max: null,
    pcie_rx_kbps: null,
    pcie_tx_kbps: null,
    timestamp: ts.iso,
    timestamp_epoch: ts.epoch,
  };
}

export function mapRocmInfoToSamples(info: RocmInfo): GpuSample[] {
  const ts = nowTimestamp();
  return info.cards.map((c) => mapRocmCardToSample(c, info.driverVersion, ts));
}

/**
 * Parse `rocm-smi --showpids --json`. The value of each PID<n> key is
 * a *string* of 5 comma-separated fields, not a nested object —
 * "process_name, gpu_count, vram_bytes, sdma_bytes, cu_occupancy".
 * Empty input (no GPU processes) returns []. CU occupancy comes back
 * as null when the driver reports "unknown"/"UNKNOWN".
 */
export function parseRocmPids(jsonText: string): RocmProcess[] {
  if (!jsonText || !jsonText.trim()) return [];
  let parsed: { system?: Record<string, string> };
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const system = parsed?.system;
  if (!system || typeof system !== 'object') return [];
  const result: RocmProcess[] = [];
  for (const [key, raw] of Object.entries(system)) {
    const m = /^PID(\d+)$/.exec(key);
    if (!m || typeof raw !== 'string') continue;
    const fields = raw.split(',').map((s) => s.trim());
    if (fields.length < 5) continue;
    const pid = Number.parseInt(m[1], 10);
    if (!Number.isFinite(pid)) continue;
    const gpuCount = Number.parseInt(fields[1], 10);
    const vram = Number.parseInt(fields[2], 10);
    const sdma = Number.parseInt(fields[3], 10);
    const cuRaw = fields[4];
    const cu = /^unknown$/i.test(cuRaw) ? null : Number.parseInt(cuRaw, 10);
    result.push({
      pid,
      process_name: fields[0],
      gpu_count: Number.isFinite(gpuCount) ? gpuCount : 0,
      vram_used_bytes: Number.isFinite(vram) ? vram : 0,
      sdma_used_bytes: Number.isFinite(sdma) ? sdma : 0,
      cu_occupancy: cu !== null && Number.isFinite(cu) ? cu : null,
    });
  }
  return result;
}
