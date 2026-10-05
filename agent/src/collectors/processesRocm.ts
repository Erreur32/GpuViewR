// Per-host GPU-process collector for AMD (and Intel, fdinfo only). The
// KFD (ROCm compute) pid list comes from /sys/class/kfd (kfdSysfs.ts)
// when readable, else from `rocm-smi --showpids`; the notes below are
// about that rocm-smi fallback.
// Same wire shape as the nvidia variant (AgentGpuProcess[]) so the
// hub's agentIngestWS doesn't care which vendor produced the frame.
//
// rocm-smi quirks worth knowing:
//  - --showpids returns a single CSV string per PID, not an object;
//    parsing lives in parsers/rocm.
//  - Empty case = stdout empty, exit 0, harmless WARNING on stderr.
//  - No equivalent of nvidia-smi pmon → gpu_pct is always null.
//  - No process type (C/G/G+C) — we set 'C' (compute) which is what
//    ROCm overwhelmingly hosts in practice.
//  - We bundle --showbus into the same call so we can map each pid to
//    a stable synthesized gpu_uuid (ROCm-${pciBus}). Cheap and avoids
//    a per-tick extra spawn.
//  - --showpids only tells us *how many* cards a pid uses, not which
//    one. Multi-card attribution is NOT done via `rocm-smi
//    --showpidgpus`: as of the current upstream rocm-smi source, its
//    --json mode silently drops the per-pid device-index list
//    (printListLog() only prints when PRINT_JSON is false — the data
//    is computed then thrown away), so there is nothing machine-
//    readable to parse from it. Instead we cross-reference the DRM
//    fdinfo scan (processesAmdgpuFdinfo.ts, kernel interface since
//    Linux 5.19) for each rocm-reported pid: its `drm-pdev` field
//    says exactly which card(s) a pid's fds are open on, so a pid
//    that touches N cards gets N rows below, each with that card's
//    own fdinfo-reported VRAM. Falls back to card0 (with a one-shot
//    warning on multi-card boxes) only for a pid with zero DRM fd
//    visibility — kernel <5.19, restricted /proc, or a pure-KFD
//    client that never opened a render node.
//  - rocm-smi only sees processes that opened /dev/kfd (ROCm/HIP
//    compute). A Vulkan/OpenGL-only workload (e.g. llama.cpp built
//    against Vulkan) never touches KFD and is invisible here — we
//    additively merge in processesAmdgpuFdinfo.ts's DRM fdinfo scan
//    to cover that case too. rocm-smi's data wins on any pid overlap.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  parseRocmInfo,
  parseRocmPids,
  rocmUuidFromBus,
} from "../../../server/services/parsers/rocm.js";
import type {
  AgentGpuProcess,
  ProcessCollectorHandle,
  ProcessCollectorOptions,
  ProcessSnapshot,
} from "./processes.js";
import {
  createCpuSampler,
  readCmdline,
  readContainer,
  resolveProcessName,
} from "./_procTicks.js";
import {
  AMD_DRIVERS,
  createFdinfoGpuSampler,
  createFdinfoScanState,
  hasPtraceCap,
  INTEL_DRIVERS,
  scanAmdgpuFdinfo,
} from "./processesAmdgpuFdinfo.js";
import { intelUuidFromBus } from "./gpuIntel.js";
import { kfdAvailable, readKfdGpuBuses, readKfdProcesses } from "./kfdSysfs.js";
import { classifyLLM } from "./llmClassifier.js";
// Note: LLMResolvers is re-exported through ProcessCollectorOptions
// (Omit<...>) below — no direct import needed here.
import { logger } from "../logger.js";

export type { ProcessSnapshot };

const MIN_TICK_MS = 1_000;

const PIDS_FLAGS = ["--showpids", "--showbus", "--json"];

/** rocm-smi is a Python script: one run costs ~120 ms of CPU, and every
 *  2 s that was 2.5 % of a core on a Strix Halo (Jarvis, 2026-10-05),
 *  twice what the agent itself used. The fdinfo scan, which gives VRAM,
 *  GTT, GPU % and the card of each pid, still runs every tick; only the
 *  KFD pid list and CU occupancy are refreshed on this slower cadence
 *  (collector 2.95 % -> 0.79 % of a core, same Jarvis box). */
const ROCM_SMI_REFRESH_MS = 10_000;

/** Last rocm-smi output, re-run at most every `refreshMs`. */
export function createRocmSmiCache(run: () => Promise<string>, refreshMs = ROCM_SMI_REFRESH_MS) {
  let out = "";
  let fetchedAt = Number.NEGATIVE_INFINITY;
  return async (now: number = Date.now()): Promise<string> => {
    if (now - fetchedAt >= refreshMs) {
      out = await run();
      fetchedAt = now;
    }
    return out;
  };
}

export type RocmProcessCollectorOptions = Omit<
  ProcessCollectorOptions,
  "nvidiaSmiPath"
> & {
  rocmSmiPath: string;
  /** /sys/class/drm, used to find the cards when rocm-smi is missing
   *  (fdinfo-only mode). */
  sysClassDrm?: string;
  /** 'intel': i915/xe cards, fdinfo only, rocm-smi never spawned. */
  family?: "amd" | "intel";
  /** /sys/class/kfd/kfd, override for tests. */
  kfdRoot?: string;
};

/** A KFD process with its VRAM per card (bus id), whichever source. */
interface KfdPid {
  pid: number;
  name: string;
  /** Per-card VRAM when known (sysfs); rocm-smi only gives a total. */
  vramByBus: Map<string, number> | null;
  vramBytes: number;
  cuOccupancy: number | null;
}

/** PCI bus ids of the cards bound to `drivers` under sysClassDrm, read
 *  from each card's device/uevent (`DRIVER=amdgpu`, `PCI_SLOT_NAME=...`).
 *  Same bus id the sysfs GPU collectors turn into the card uuid. */
export function amdgpuBusIds(sysClassDrm: string, drivers: ReadonlySet<string> = AMD_DRIVERS): string[] {
  let entries: string[];
  try {
    entries = readdirSync(sysClassDrm);
  } catch {
    return [];
  }
  const buses = new Set<string>();
  for (const name of entries) {
    if (!/^card\d+$/.test(name)) continue;
    try {
      const uevent = readFileSync(`${sysClassDrm}/${name}/device/uevent`, "utf8");
      const driver = /^DRIVER=(\S+)$/m.exec(uevent)?.[1];
      if (!driver || !drivers.has(driver)) continue;
      const slot = /^PCI_SLOT_NAME=(\S+)$/m.exec(uevent)?.[1];
      if (slot) buses.add(slot.toLowerCase());
    } catch {
      // card without a readable uevent: not ours to report
    }
  }
  return [...buses].sort((a, b) => a.localeCompare(b));
}

export function createRocmProcessCollector(
  opts: RocmProcessCollectorOptions,
): ProcessCollectorHandle {
  const tickMs = Math.max(opts.tickMs, MIN_TICK_MS);
  let timer: NodeJS.Timeout | null = null;
  let rocmSmiAvailable: boolean | null = null;
  let inflight = false;
  let multiCardFallbackWarned = false;
  const cpuSampler = createCpuSampler(opts.hostProc);
  const fdinfoSampler = createFdinfoGpuSampler();
  // Denied pids + first-seen ages, see scanAmdgpuFdinfo.
  const fdinfoScanState = createFdinfoScanState();
  let fdinfoDeniedWarned = false;
  // Capabilities don't change over the agent's life.
  const ptrace = hasPtraceCap();
  // Without rocm-smi (amdgpu driver only, no ROCm install) the list
  // comes from the DRM fdinfo scan alone: same rows minus CU occupancy,
  // and KFD-only clients that never opened a render node are missed.
  const intel = opts.family === "intel";
  const drivers = intel ? INTEL_DRIVERS : AMD_DRIVERS;
  const uuidFromBus = intel ? intelUuidFromBus : rocmUuidFromBus;
  const rocmSmiOutput = createRocmSmiCache(() => spawnPidsAndBus());
  // KFD pids from sysfs when the kernel exposes them (any ROCm-capable
  // amdgpu): same list as rocm-smi --showpids, per card, at no cost.
  // rocm-smi stays the fallback for hosts where it can't be read.
  const kfdRoot = opts.kfdRoot ?? "/sys/class/kfd/kfd";
  const useKfdSysfs = !intel && kfdAvailable(kfdRoot);
  const kfdBuses = useKfdSysfs ? readKfdGpuBuses(kfdRoot) : new Map<number, string>();

  /** KFD processes and the card bus ids, from sysfs or rocm-smi. */
  async function kfdPids(): Promise<{ pids: KfdPid[]; buses: string[] }> {
    if (useKfdSysfs) {
      const pids = readKfdProcesses(kfdRoot, kfdBuses).map((p) => ({
        pid: p.pid,
        name: "",
        vramByBus: p.vramByBus,
        vramBytes: [...p.vramByBus.values()].reduce((a, b) => a + b, 0),
        cuOccupancy: null,
      }));
      return { pids, buses: cardBuses() };
    }
    const out = checkRocmSmi() ? await rocmSmiOutput() : "";
    const info = parseRocmInfo(out);
    // The cached list can be up to ROCM_SMI_REFRESH_MS old: drop pids
    // that have exited since.
    const pids = parseRocmPids(out)
      .filter((p) => existsSync(`${opts.hostProc}/${p.pid}`))
      .map((p) => ({ pid: p.pid, name: p.process_name, vramByBus: null, vramBytes: p.vram_used_bytes, cuOccupancy: p.cu_occupancy }));
    return { pids, buses: info.cards.length > 0 ? info.cards.map((c) => c.raw["PCI Bus"]) : cardBuses() };
  }
  let sysfsBuses: string[] | null = null;
  const cardBuses = (): string[] => {
    sysfsBuses ??= amdgpuBusIds(opts.sysClassDrm ?? "/sys/class/drm", drivers);
    return sysfsBuses;
  };

  function checkRocmSmi(): boolean {
    if (intel) return false;
    if (rocmSmiAvailable !== null) return rocmSmiAvailable;
    try {
      const r = spawnSync(opts.rocmSmiPath, ["--version"], { timeout: 3_000 });
      rocmSmiAvailable = r.status === 0;
    } catch {
      rocmSmiAvailable = false;
    }
    return rocmSmiAvailable;
  }

  function spawnPidsAndBus(): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(opts.rocmSmiPath, PIDS_FLAGS);
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      // libdrm warning + "No JSON data to report" both land here; both
      // are benign and the JSON we want sits on stdout. Drop silently.
      child.stderr.on("data", () => {
        /* ignore */
      });
      child.on("error", () => resolve(""));
      child.on("close", () => resolve(stdout));
    });
  }

  async function tick(): Promise<void> {
    if (inflight) return;
    inflight = true;
    try {
      const { pids: procs, buses } = await kfdPids();

      // Fallback uuid for a pid with zero DRM fdinfo visibility (see
      // the module header comment). Real per-card attribution below
      // comes from fdinfoRaw, not this.
      const defaultUuid = uuidFromBus(buses[0]);
      const isMultiCard = buses.length > 1;

      const rocmPids = new Set(procs.map((p) => p.pid));

      // Scanned once per tick, for every pid regardless of how it was
      // discovered — drm-pdev per (pid, fd) is what makes correct
      // multi-card attribution possible for both branches below.
      const fdinfoRaw = scanAmdgpuFdinfo(opts.hostProc, fdinfoScanState, Date.now(), drivers);
      const deniedCount = fdinfoScanState.deniedPids.size;
      if (deniedCount > 0 && !fdinfoDeniedWarned) {
        fdinfoDeniedWarned = true;
        logger.warn(
          "proc",
          `DRM fdinfo unreadable for ${deniedCount} pid(s), most likely processes running directly on the host (AppArmor docker-default denies ptrace reads of unconfined peers) or CAP_SYS_PTRACE is missing. Vulkan/OpenGL clients among them won't be listed, other containers are unaffected. Not retried until those pids exit.`,
        );
      }

      const enrichedFromRocm: AgentGpuProcess[] = procs.flatMap((p) => {
        const command = readCmdline(p.pid, opts.hostProc);
        // rocm-smi --showpids regularly returns an empty process_name
        // field (driver build / permissions dependent — most visible
        // when the hub runs in a container without CAP_SYS_PTRACE).
        // Fall back to argv[0] basename, then /proc/<pid>/comm — same
        // ladder the nvidia collector uses for [Not Found] / N/A rows.
        let name = p.name;
        if (
          !name ||
          name.toLowerCase() === "unknown" ||
          name === "[Not Found]" ||
          name === "-" ||
          name.toLowerCase() === "n/a"
        ) {
          name = resolveProcessName(p.pid, opts.hostProc) ?? "";
        }
        const llm = classifyLLM(command, opts.llmResolvers, p.pid);
        const container = readContainer(p.pid, opts.hostProc);
        // Stateful (delta-based) sampler — must be called exactly once
        // per pid per tick even though a multi-card pid below produces
        // several rows, so hoist it here rather than call it per-row.
        const cpuPct = cpuSampler.sample(p.pid);

        const devices = fdinfoRaw.get(p.pid);
        // No DRM fd but sysfs knows its cards: one row per card, no
        // card0 guess.
        if ((!devices || devices.length === 0) && p.vramByBus && p.vramByBus.size > 0) {
          return [...p.vramByBus].map(([bus, bytes]) => ({
            pid: p.pid,
            process_name: name || "unknown",
            gpu_uuid: uuidFromBus(bus),
            used_memory: Math.floor(bytes / 1048576),
            type: "C" as const,
            command,
            cpu_pct: cpuPct,
            gpu_pct: null,
            llm_runtime: llm.runtime,
            llm_model: llm.model,
            llm_hint: llm.hint,
            container_engine: container?.engine ?? null,
            container_id: container?.id ?? null,
          }));
        }
        if (!devices || devices.length === 0) {
          // One-shot per collector lifetime, not per pid: this can
          // recur silently for other pids afterwards (intermittent
          // /proc access restriction, several processes with no DRM
          // fd) — the goal is just to surface that the fallback path
          // is active on this host at all, not an exhaustive log of
          // every occurrence.
          if (isMultiCard && !multiCardFallbackWarned) {
            multiCardFallbackWarned = true;
            logger.warn(
              "proc",
              `no DRM fdinfo visibility for at least one pid (first seen: ${p.pid}) on a multi-GPU AMD host — attributing to card0 (older kernel or restricted /proc access?). May recur silently for other pids.`,
            );
          }
          return [
            {
              pid: p.pid,
              process_name: name || "unknown",
              gpu_uuid: defaultUuid,
              used_memory: Math.floor(p.vramBytes / 1048576),
              type: "C" as const,
              command,
              cpu_pct: cpuPct,
              // CU occupancy is the AMD equivalent of nvidia-smi's pmon
              // SM%: share of compute units this pid is using. Surface
              // it as gpu_pct so the UI can render a real number
              // instead of a permanent "—". Null when the driver
              // reports "unknown" (some kernels / non-root callers).
              gpu_pct: p.cuOccupancy,
              llm_runtime: llm.runtime,
              llm_model: llm.model,
              llm_hint: llm.hint,
              container_engine: container?.engine ?? null,
              container_id: container?.id ?? null,
            },
          ];
        }

        // One row per card this pid's fds are actually open on. VRAM
        // comes from fdinfo's own per-device counter — not rocm-smi's
        // single pid-wide aggregate — so the split is self-consistent.
        // cu_occupancy has no per-card breakdown available from
        // rocm-smi, so the same pid-wide value is repeated on every
        // row: an approximation, still strictly better than today's
        // everything-on-card0 behaviour. When rocm-smi reports it as
        // UNKNOWN (most kernels / APUs), the per-card engine time from
        // fdinfo gives the process's own GPU % instead: without it the
        // UI fell back to the whole card's utilisation on every row.
        return devices.map((d) => ({
          pid: p.pid,
          process_name: name || "unknown",
          // A device entry can have a null pdev (fd readable but the
          // kernel's drm-pdev line was missing/unparsable) — fall back
          // to defaultUuid rather than the synthetic "ROCm-unknown",
          // so the row still joins against the real GPU card list the
          // UI keys on (${pid}-${gpu_uuid}, see the module header).
          gpu_uuid: d.pdev ? uuidFromBus(d.pdev) : defaultUuid,
          used_memory: Math.floor(d.vramBytes / 1048576),
          gtt_memory: Math.floor(d.gttBytes / 1048576),
          type: "C" as const,
          command,
          cpu_pct: cpuPct,
          gpu_pct: p.cuOccupancy ?? fdinfoSampler.sample(p.pid, d).gpuPct,
          llm_runtime: llm.runtime,
          llm_model: llm.model,
          llm_hint: llm.hint,
          container_engine: container?.engine ?? null,
          container_id: container?.id ?? null,
        }));
      });

      // Fill in whatever rocm-smi missed: Vulkan/OpenGL clients that
      // never opened /dev/kfd but do hold an amdgpu DRM fd. Skip any
      // pid rocm-smi already reported (handled above via fdinfoRaw
      // directly), so its cu_occupancy-based data always wins on
      // overlap. One row per card, same rule as the branch above.
      const enrichedFromFdinfo: AgentGpuProcess[] = [];
      for (const [pid, devices] of fdinfoRaw) {
        if (rocmPids.has(pid)) continue;
        const command = readCmdline(pid, opts.hostProc);
        const name = resolveProcessName(pid, opts.hostProc) ?? "unknown";
        const llm = classifyLLM(command, opts.llmResolvers, pid);
        const container = readContainer(pid, opts.hostProc);
        const cpuPct = cpuSampler.sample(pid); // once per pid per tick
        for (const usage of devices) {
          const { gpuPct, type } = fdinfoSampler.sample(pid, usage);
          enrichedFromFdinfo.push({
            pid,
            process_name: name,
            // Same null-pdev fallback as the rocm-attributed branch
            // above: prefer the real defaultUuid over the synthetic
            // "ROCm-unknown" sentinel when drm-pdev was unreadable.
            gpu_uuid: usage.pdev ? uuidFromBus(usage.pdev) : defaultUuid,
            used_memory: Math.floor(usage.vramBytes / 1048576),
            gtt_memory: Math.floor(usage.gttBytes / 1048576),
            type,
            command,
            cpu_pct: cpuPct,
            gpu_pct: gpuPct,
            llm_runtime: llm.runtime,
            llm_model: llm.model,
            llm_hint: llm.hint,
            container_engine: container?.engine ?? null,
            container_id: container?.id ?? null,
          });
        }
      }

      const enriched = [...enrichedFromRocm, ...enrichedFromFdinfo];
      cpuSampler.retain(new Set(enriched.map((p) => p.pid)));
      fdinfoSampler.retain(new Set(fdinfoRaw.keys()));
      opts.onSnapshot({
        tsEpoch: Math.floor(Date.now() / 1000),
        processes: enriched,
        ...(deniedCount > 0
          ? { visibility: { denied_pids: deniedCount, has_ptrace: ptrace } }
          : {}),
      });
    } finally {
      inflight = false;
    }
  }

  return {
    available(): boolean {
      return useKfdSysfs || checkRocmSmi() || cardBuses().length > 0;
    },
    start(): void {
      if (timer) return;
      if (useKfdSysfs) {
        logger.success(
          "proc",
          `AMD process collector started from KFD sysfs + DRM fdinfo, rocm-smi not needed (tick=${tickMs}ms, ${kfdBuses.size} KFD GPU(s), hostProc=${opts.hostProc})`,
        );
      } else if (checkRocmSmi()) {
        logger.success(
          "proc",
          `ROCm process collector started (tick=${tickMs}ms, hostProc=${opts.hostProc})`,
        );
      } else if (cardBuses().length > 0) {
        logger.success(
          "proc",
          intel
            ? `Intel process collector started from DRM fdinfo (tick=${tickMs}ms, hostProc=${opts.hostProc})`
            : `AMD process collector started from DRM fdinfo only, rocm-smi not found at ${opts.rocmSmiPath} (tick=${tickMs}ms, hostProc=${opts.hostProc}). ROCm-only clients without a render node fd won't be listed.`,
        );
      } else {
        logger.warn(
          "proc",
          `neither rocm-smi (${opts.rocmSmiPath}) nor an amdgpu card found, AMD process collector disabled`,
        );
        return;
      }
      void tick();
      timer = setInterval(() => {
        void tick();
      }, tickMs);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
