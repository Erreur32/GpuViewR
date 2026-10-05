// KFD (ROCm compute) processes straight from the kernel, replacing a
// `rocm-smi --showpids --showbus --json` spawn. rocm-smi is a Python script
// (~120 ms of CPU per run) that reads these same files:
//
//   /sys/class/kfd/kfd/proc/<pid>/vram_<gpu_id>     bytes, one per GPU used
//   /sys/class/kfd/kfd/topology/nodes/<n>/gpu_id    0 for CPU nodes
//   /sys/class/kfd/kfd/topology/nodes/<n>/properties
//       domain <pci domain>, location_id <(bus << 8) | (dev << 3) | fn>
//
// Pids are host pids, and the files are readable from the Docker agent
// (checked on Jarvis, Strix Halo, 2026-10-05). Unlike rocm-smi, each pid's
// VRAM comes per card, so a pid on two GPUs is attributed correctly even
// without DRM fdinfo. rocm-smi's CU occupancy is not available here; it
// read UNKNOWN on every host we measured.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface KfdProcess {
  pid: number;
  /** VRAM in bytes per card, keyed by PCI bus id ("0000:c5:00.0"). */
  vramByBus: Map<string, number>;
}

/** `0000:c5:00.0` from a KFD node's domain and location_id. */
export function busFromLocation(domain: number, locationId: number): string {
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  const bus = (locationId >> 8) & 0xff;
  const dev = (locationId >> 3) & 0x1f;
  const fn = locationId & 0x7;
  return `${hex(domain, 4)}:${hex(bus, 2)}:${hex(dev, 2)}.${fn}`;
}

function readNumber(path: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** gpu_id -> PCI bus id for every GPU node of the KFD topology. */
export function readKfdGpuBuses(kfdRoot: string): Map<number, string> {
  const out = new Map<number, string>();
  const nodesDir = join(kfdRoot, "topology", "nodes");
  let nodes: string[];
  try {
    nodes = readdirSync(nodesDir);
  } catch {
    return out;
  }
  for (const node of nodes) {
    const gpuId = readNumber(join(nodesDir, node, "gpu_id"));
    if (!gpuId) continue; // 0 = CPU node
    let props: string;
    try {
      props = readFileSync(join(nodesDir, node, "properties"), "utf8");
    } catch {
      continue;
    }
    const domain = Number(/^domain\s+(\d+)$/m.exec(props)?.[1] ?? 0);
    const location = /^location_id\s+(\d+)$/m.exec(props)?.[1];
    if (location === undefined) continue;
    out.set(gpuId, busFromLocation(domain, Number(location)));
  }
  return out;
}

/** True when this host exposes the KFD process list (ROCm driver loaded). */
export function kfdAvailable(kfdRoot: string): boolean {
  try {
    readdirSync(join(kfdRoot, "proc"));
    return true;
  } catch {
    return false;
  }
}

/** Every process with a KFD context, with its VRAM per card. `buses` comes
 *  from readKfdGpuBuses (topology is fixed, read it once). */
export function readKfdProcesses(kfdRoot: string, buses: Map<number, string>): KfdProcess[] {
  const procDir = join(kfdRoot, "proc");
  let pids: string[];
  try {
    pids = readdirSync(procDir);
  } catch {
    return [];
  }
  const out: KfdProcess[] = [];
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    let files: string[];
    try {
      files = readdirSync(join(procDir, entry));
    } catch {
      continue; // exited between the two readdirs
    }
    const vramByBus = new Map<string, number>();
    for (const f of files) {
      const m = /^vram_(\d+)$/.exec(f);
      if (!m) continue;
      const bus = buses.get(Number(m[1]));
      const bytes = readNumber(join(procDir, entry, f));
      if (bus && bytes !== null) vramByBus.set(bus, bytes);
    }
    out.push({ pid: Number(entry), vramByBus });
  }
  return out;
}
