// Intel GPU collector (i915 and xe kernel drivers), Linux only.
//
// Intel ships no nvidia-smi / rocm-smi equivalent that a monitoring agent
// can rely on (intel_gpu_top needs root and a PMU), so everything comes
// from the kernel:
//   - cards: /sys/class/drm/cardN/device/uevent (DRIVER=i915|xe),
//   - clock: i915 cardN/gt_act_freq_mhz, xe device/tile0/gt0/freq0/act_freq,
//   - temperature / power: the card's hwmon (discrete Arc only),
//   - utilization and memory: summed DRM fdinfo of every client process
//     (same scan as the AMD process list, see processesAmdgpuFdinfo.ts).
//
// Limits, by design: xe reports engine time in GPU cycles, not ns, so
// utilization stays null there; memory_total is unknown (null) because
// neither driver exposes it in sysfs; on an iGPU, memory_used is the
// system memory mapped to the GPU (there is no VRAM). Unverified on real
// hardware as of v0.11.0: built against the kernel's drm-usage-stats doc
// and the i915/xe sysfs ABI.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GpuSample } from "../../../server/services/parsers/nvidia.js";
import { logger } from "../logger.js";
import type { GpuCollectorHandle } from "./gpu.js";
import {
  createFdinfoScanState,
  INTEL_DRIVERS,
  scanAmdgpuFdinfo,
} from "./processesAmdgpuFdinfo.js";

const CARD_RE = /^card(\d+)$/;

/** Stable card id for Intel GPUs, same shape as rocmUuidFromBus. */
export function intelUuidFromBus(pciBus: string | undefined): string {
  if (!pciBus) return "Intel-unknown";
  return `Intel-${pciBus.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_")}`;
}

/** A few discrete cards worth naming; everything else is "Intel Graphics". */
const DEVICE_NAMES: Record<string, string> = {
  "56a0": "Intel Arc A770",
  "56a1": "Intel Arc A750",
  "56a5": "Intel Arc A380",
  "56a6": "Intel Arc A310",
  e20b: "Intel Arc B580",
  e20c: "Intel Arc B570",
};

export interface IntelCard {
  index: number;
  driver: string;
  pciBus: string;
  name: string;
  devicePath: string;
  cardPath: string;
  hwmonPath: string | null;
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return null;
  }
}

async function readNumber(path: string): Promise<number | null> {
  const raw = await readText(path);
  if (raw === null) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function ueventField(raw: string, key: string): string | null {
  for (const line of raw.split("\n")) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return null;
}

async function hwmonDir(devicePath: string): Promise<string | null> {
  try {
    const hit = (await readdir(join(devicePath, "hwmon"))).find((e) => /^hwmon\d+$/.test(e));
    return hit ? join(devicePath, "hwmon", hit) : null;
  } catch {
    return null;
  }
}

/** Cards bound to i915 or xe, sorted by DRM index. */
export async function discoverIntelCards(sysClassDrm: string): Promise<IntelCard[]> {
  let entries: string[];
  try {
    entries = await readdir(sysClassDrm);
  } catch {
    return [];
  }
  const cards: IntelCard[] = [];
  for (const e of entries) {
    const m = CARD_RE.exec(e);
    if (!m) continue;
    const cardPath = join(sysClassDrm, e);
    const devicePath = join(cardPath, "device");
    const uevent = await readText(join(devicePath, "uevent"));
    if (!uevent) continue;
    const driver = ueventField(uevent, "DRIVER");
    if (!driver || !INTEL_DRIVERS.has(driver)) continue;
    const deviceId = (ueventField(uevent, "PCI_ID") ?? "").split(":")[1]?.toLowerCase() ?? "";
    cards.push({
      index: Number.parseInt(m[1], 10),
      driver,
      pciBus: (ueventField(uevent, "PCI_SLOT_NAME") ?? "").toLowerCase(),
      name: DEVICE_NAMES[deviceId] ?? (deviceId ? `Intel Graphics [8086:${deviceId}]` : "Intel Graphics"),
      devicePath,
      cardPath,
      hwmonPath: await hwmonDir(devicePath),
    });
  }
  return cards.sort((a, b) => a.index - b.index);
}

async function readClockMhz(card: IntelCard): Promise<number | null> {
  if (card.driver === "i915") return readNumber(join(card.cardPath, "gt_act_freq_mhz"));
  return readNumber(join(card.devicePath, "tile0", "gt0", "freq0", "act_freq"));
}

/** Per-card totals from one fdinfo scan. */
export interface IntelCardUsage {
  busyNs: number;
  vramBytes: number;
  gttBytes: number;
}

export function sumUsageByCard(
  scan: Map<number, { pdev: string | null; vramBytes: number; gttBytes: number; gfxNs: number; computeNs: number }[]>,
  defaultBus: string,
): Map<string, IntelCardUsage> {
  const out = new Map<string, IntelCardUsage>();
  for (const devices of scan.values()) {
    for (const d of devices) {
      const bus = d.pdev?.toLowerCase() ?? defaultBus;
      const acc = out.get(bus) ?? { busyNs: 0, vramBytes: 0, gttBytes: 0 };
      acc.busyNs += d.gfxNs + d.computeNs;
      acc.vramBytes += d.vramBytes;
      acc.gttBytes += d.gttBytes;
      out.set(bus, acc);
    }
  }
  return out;
}

export type IntelGpuCollectorOptions = Readonly<{
  sysClassDrm: string;
  hostProc: string;
  tickMs: number;
  onSample: (samples: GpuSample[]) => void;
}>;

export interface IntelGpuCollectorHandle extends GpuCollectorHandle {
  discover(): Promise<number>;
}

export function createIntelGpuCollector(opts: IntelGpuCollectorOptions): IntelGpuCollectorHandle {
  let cards: IntelCard[] | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inflight = false;
  const scanState = createFdinfoScanState();
  // Previous busy ns / energy per card for the deltas.
  const prevBusy = new Map<string, { ns: number; at: number }>();
  const prevEnergy = new Map<string, { uj: number; at: number }>();

  async function ensureCards(): Promise<IntelCard[]> {
    cards ??= await discoverIntelCards(opts.sysClassDrm);
    return cards;
  }

  function utilization(bus: string, busyNs: number, now: number, driver: string): number | null {
    if (driver === "xe") return null; // cycles, not ns
    const before = prevBusy.get(bus);
    prevBusy.set(bus, { ns: busyNs, at: now });
    if (!before || now <= before.at || busyNs < before.ns) return null;
    const pct = ((busyNs - before.ns) / ((now - before.at) * 1e6)) * 100;
    return Math.min(100, Math.round(pct * 10) / 10);
  }

  async function power(card: IntelCard, now: number): Promise<number> {
    if (!card.hwmonPath) return 0;
    const direct = await readNumber(join(card.hwmonPath, "power1_input"));
    if (direct !== null) return Math.round(direct / 1_000_000);
    const uj = await readNumber(join(card.hwmonPath, "energy1_input"));
    if (uj === null) return 0;
    const before = prevEnergy.get(card.pciBus);
    prevEnergy.set(card.pciBus, { uj, at: now });
    if (!before || now <= before.at || uj < before.uj) return 0;
    return Math.round((uj - before.uj) / ((now - before.at) * 1000));
  }

  async function tick(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const list = await ensureCards();
      if (list.length === 0) return;
      const now = Date.now();
      const usage = sumUsageByCard(scanAmdgpuFdinfo(opts.hostProc, scanState, now, INTEL_DRIVERS), list[0].pciBus);
      const epoch = Math.floor(now / 1000);
      const iso = new Date(now).toISOString();
      const samples = await Promise.all(list.map(async (card): Promise<GpuSample> => {
        const u = usage.get(card.pciBus) ?? { busyNs: 0, vramBytes: 0, gttBytes: 0 };
        const tempMilli = card.hwmonPath ? await readNumber(join(card.hwmonPath, "temp1_input")) : null;
        // iGPU: no VRAM, the GPU works out of mapped system memory.
        const memBytes = u.vramBytes > 0 ? u.vramBytes : u.gttBytes;
        return {
          gpu_index: card.index,
          name: card.name,
          uuid: intelUuidFromBus(card.pciBus),
          driver_version: card.driver,
          temperature: tempMilli === null ? 0 : Math.round(tempMilli / 1000),
          utilization: utilization(card.pciBus, u.busyNs, now, card.driver),
          memory_used: Math.floor(memBytes / 1048576),
          memory_total: null,
          power: await power(card, now),
          fan_speed: null,
          clock_graphics: await readClockMhz(card),
          clock_memory: null,
          pci_bus_id: card.pciBus || null,
          pcie_gen_current: null,
          pcie_gen_max: null,
          pcie_width_current: null,
          pcie_width_max: null,
          pcie_rx_kbps: null,
          pcie_tx_kbps: null,
          timestamp: iso,
          timestamp_epoch: epoch,
        };
      }));
      opts.onSample(samples);
    } catch (err) {
      logger.debug("gpu", `intel tick failed: ${(err as Error).message}`);
    } finally {
      inflight = false;
    }
  }

  return {
    available(): boolean {
      return Array.isArray(cards) && cards.length > 0;
    },
    async discover(): Promise<number> {
      return (await ensureCards()).length;
    },
    start(): void {
      if (timer) return;
      logger.success("gpu", `Intel collector started (tick=${opts.tickMs}ms, cards=${cards?.length ?? 0}, from sysfs + DRM fdinfo)`);
      void tick();
      timer = setInterval(() => { void tick(); }, opts.tickMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
