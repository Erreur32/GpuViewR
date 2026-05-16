// Sysfs-direct collector for AMD GPUs. Same `GpuCollectorHandle`
// contract as the rocm-smi and nvidia variants so index.ts can swap
// backends without touching transport.ts.
//
// Why this exists: rocm-smi is a Python script that fork+execs and
// loads librocm_smi64.so via ctypes every call (~80-130 ms wall,
// ~50-80 ms user CPU at 100 %). On a 1 Hz tick × 2 calls per tick
// (info + showpids) that's 0.2-0.4 core of permanent load on
// otherwise-idle boxes — most visible on small APUs like Strix Halo.
// Reading the same numbers straight from /sys takes < 1 ms total.
//
// The sysfs interface is a stable amdgpu kernel ABI:
//   /sys/class/drm/cardN/device/
//     uevent                 → DRIVER + PCI_SLOT_NAME + PCI_ID (one-shot)
//     gpu_busy_percent       → utilization (0..100)
//     mem_info_vram_used     → bytes
//     mem_info_vram_total    → bytes
//     pp_dpm_sclk            → DPM levels, current marked with " *"
//     hwmon/hwmonM/
//       temp1_input          → edge temp (m°C)
//       power1_average       → avg socket power (µW), absent on some parts
//   /sys/module/amdgpu/version → driver version (one-shot)
//
// Connector entries like `card0-DP-1`, `card0-HDMI-A-1` live in the
// same dir and must be filtered out (regex anchors on `^cardN$`).

import { readFile, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { GpuSample } from '../../../server/services/parsers/nvidia.js';
import { rocmDeviceName, rocmUuidFromBus } from '../../../server/services/parsers/rocm.js';
import { logger } from '../logger.js';
import { nowTimestamp } from '../../../server/services/parsers/nvidia.js';

export type SysfsGpuCollectorOptions = Readonly<{
  sysClassDrm: string;
  amdgpuModulePath?: string;   // override for tests; defaults to /sys/module/amdgpu
  tickMs: number;
  onSample: (samples: GpuSample[]) => void;
}>;

export interface SysfsGpuCollectorHandle {
  start(): void;
  stop(): void;
  available(): boolean;
  /** Resolved at boot or first start(); useful for the auto-fallback
   *  path in index.ts to decide whether to fall through to rocm-smi. */
  discover(): Promise<number>;
}

interface CardMeta {
  index: number;
  devicePath: string;
  hwmonPath: string | null;
  pciBus: string;
  deviceIdHex: string | null;
  name: string;
}

const CARD_RE = /^card(\d+)$/;

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readNumber(path: string): Promise<number | null> {
  const txt = await readText(path);
  if (txt === null) return null;
  const n = Number.parseInt(txt, 10);
  return Number.isFinite(n) ? n : null;
}

function parseUevent(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Active DPM level is the one marked with a trailing " *" — pp_dpm_sclk
 *  looks like "0: 200Mhz\n1: 605Mhz *\n2: 805Mhz". Returns MHz or null. */
function parseActiveDpm(raw: string | null): number | null {
  if (!raw) return null;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.endsWith('*')) continue;
    // "1: 605Mhz *" → grab the first numeric run after the colon
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    let buf = '';
    for (let i = colon + 1; i < trimmed.length; i++) {
      const c = trimmed.charCodeAt(i);
      const isDigit = c >= 48 && c <= 57;
      const isDot = c === 46;
      if (isDigit || isDot) buf += trimmed[i];
      else if (buf) break;
    }
    if (!buf) return null;
    const n = Number.parseFloat(buf);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function pickHwmonDir(devicePath: string): Promise<string | null> {
  const hwmonRoot = join(devicePath, 'hwmon');
  try {
    const entries = await readdir(hwmonRoot);
    const hit = entries.find((e) => /^hwmon\d+$/.test(e));
    return hit ? join(hwmonRoot, hit) : null;
  } catch {
    return null;
  }
}

/** Read /sys/class/drm, return one CardMeta per amdgpu-bound card.
 *  Cards bound to other drivers (i915, nouveau, …) are filtered out via
 *  the DRIVER= line in `device/uevent`. Connector entries (`card0-DP-1`,
 *  etc.) are rejected by the CARD_RE anchor. */
async function discoverAmdgpuCards(sysClassDrm: string): Promise<CardMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(sysClassDrm);
  } catch (err) {
    logger.debug('gpu', `sysfs amdgpu: readdir ${sysClassDrm} failed: ${(err as Error).message}`);
    return [];
  }
  const cards: CardMeta[] = [];
  for (const e of entries) {
    const m = CARD_RE.exec(e);
    if (!m) continue;
    const devicePath = join(sysClassDrm, e, 'device');
    const ueventRaw = await readText(join(devicePath, 'uevent'));
    if (!ueventRaw) continue;
    const uevent = parseUevent(ueventRaw);
    if (uevent.DRIVER !== 'amdgpu') continue;

    const pciBus = uevent.PCI_SLOT_NAME || '';
    // PCI_ID is "VENDOR:DEVICE" uppercase hex. We want "0x1586" lowercased
    // so it matches the DEVICE_NAMES keys in parsers/rocm.ts.
    let deviceIdHex: string | null = null;
    const pciId = uevent.PCI_ID || '';
    const colon = pciId.indexOf(':');
    if (colon > 0) deviceIdHex = `0x${pciId.slice(colon + 1).toLowerCase()}`;

    const hwmonPath = await pickHwmonDir(devicePath);
    cards.push({
      index: Number.parseInt(m[1], 10),
      devicePath,
      hwmonPath,
      pciBus,
      deviceIdHex,
      name: rocmDeviceName(deviceIdHex ?? undefined, undefined),
    });
  }
  cards.sort((a, b) => a.index - b.index);
  return cards;
}

async function readDriverVersion(amdgpuModulePath: string): Promise<string | null> {
  return readText(join(amdgpuModulePath, 'version'));
}

async function sampleCard(meta: CardMeta, driverVersion: string | null): Promise<GpuSample> {
  const [
    busy,
    vramUsedBytes,
    vramTotalBytes,
    sclkRaw,
    tempUC,
    powerUW,
  ] = await Promise.all([
    readNumber(join(meta.devicePath, 'gpu_busy_percent')),
    readNumber(join(meta.devicePath, 'mem_info_vram_used')),
    readNumber(join(meta.devicePath, 'mem_info_vram_total')),
    readText(join(meta.devicePath, 'pp_dpm_sclk')),
    meta.hwmonPath ? readNumber(join(meta.hwmonPath, 'temp1_input')) : Promise.resolve(null),
    meta.hwmonPath ? readNumber(join(meta.hwmonPath, 'power1_average')) : Promise.resolve(null),
  ]);

  const ts = nowTimestamp();
  return {
    gpu_index: meta.index,
    name: meta.name,
    uuid: rocmUuidFromBus(meta.pciBus),
    driver_version: driverVersion,
    // m°C → °C. Matches the rounding rocm-smi does for `temp1_input`.
    temperature: tempUC !== null ? Math.round(tempUC / 1000) : 0,
    utilization: busy,
    memory_used: vramUsedBytes !== null ? Math.floor(vramUsedBytes / 1048576) : 0,
    memory_total: vramTotalBytes !== null ? Math.floor(vramTotalBytes / 1048576) : null,
    // µW → W. APUs like Strix Halo expose this; older discrete RX 6000
    // sometimes don't — we return 0 to match the rocm-smi mapping which
    // also coerces nulls to 0 for the `power` field.
    power: powerUW !== null ? Math.round(powerUW / 1_000_000) : 0,
    fan_speed: null,
    clock_graphics: parseActiveDpm(sclkRaw),
    clock_memory: null,
    pci_bus_id: meta.pciBus || null,
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

export function createAmdgpuSysfsCollector(opts: SysfsGpuCollectorOptions): SysfsGpuCollectorHandle {
  let timer: NodeJS.Timeout | null = null;
  let cards: CardMeta[] | null = null;
  let driverVersion: string | null = null;
  let inflight = false;
  const amdgpuModulePath = opts.amdgpuModulePath ?? '/sys/module/amdgpu';

  async function ensureDiscovery(): Promise<CardMeta[]> {
    if (cards !== null) return cards;
    cards = await discoverAmdgpuCards(opts.sysClassDrm);
    driverVersion = await readDriverVersion(amdgpuModulePath);
    return cards;
  }

  async function tick(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const c = await ensureDiscovery();
      if (c.length === 0) return;
      const samples = await Promise.all(c.map((m) => sampleCard(m, driverVersion)));
      opts.onSample(samples);
    } catch (err) {
      logger.debug('gpu', `sysfs amdgpu tick failed: ${(err as Error).message}`);
    } finally {
      inflight = false;
    }
  }

  return {
    available(): boolean {
      // Discovery is async (readdir + readFile per entry). The dispatcher
      // calls discover() once at boot to populate the cache; available()
      // then reflects whether at least one amdgpu card was found.
      return Array.isArray(cards) && cards.length > 0;
    },
    async discover(): Promise<number> {
      const c = await ensureDiscovery();
      return c.length;
    },
    start(): void {
      if (timer) return;
      const count = cards?.length ?? 0;
      logger.success('gpu', `sysfs amdgpu collector started (tick=${opts.tickMs}ms, cards=${count}, drm=${opts.sysClassDrm})`);
      void tick();
      timer = setInterval(() => { void tick(); }, opts.tickMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

// Exposed for the test suite — discovery and parsing are pure enough to
// validate without spinning up the collector.
export const __test = { discoverAmdgpuCards, parseActiveDpm, parseUevent, sampleCard };
