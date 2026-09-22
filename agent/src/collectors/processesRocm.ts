// Per-host GPU-process collector backed by `rocm-smi --showpids`.
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
  resolveProcessName,
} from "./_procTicks.js";
import {
  createFdinfoGpuSampler,
  scanAmdgpuFdinfo,
} from "./processesAmdgpuFdinfo.js";
import { classifyLLM } from "./llmClassifier.js";
// Note: LLMResolvers is re-exported through ProcessCollectorOptions
// (Omit<...>) below — no direct import needed here.
import { logger } from "../logger.js";

export type { ProcessSnapshot };

const MIN_TICK_MS = 1_000;

const PIDS_FLAGS = ["--showpids", "--showbus", "--json"];

export type RocmProcessCollectorOptions = Omit<
  ProcessCollectorOptions,
  "nvidiaSmiPath"
> & {
  rocmSmiPath: string;
};

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

  function checkRocmSmi(): boolean {
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
      const out = await spawnPidsAndBus();
      const procs = parseRocmPids(out);
      const info = parseRocmInfo(out);

      // Fallback uuid for a pid with zero DRM fdinfo visibility (see
      // the module header comment). Real per-card attribution below
      // comes from fdinfoRaw, not this.
      const uuids = info.cards.map((c) => rocmUuidFromBus(c.raw["PCI Bus"]));
      const defaultUuid = uuids[0] ?? "ROCm-unknown";
      const isMultiCard = info.cards.length > 1;

      const rocmPids = new Set(procs.map((p) => p.pid));

      // Scanned once per tick, for every pid regardless of how it was
      // discovered — drm-pdev per (pid, fd) is what makes correct
      // multi-card attribution possible for both branches below.
      const fdinfoRaw = scanAmdgpuFdinfo(opts.hostProc);

      const enrichedFromRocm: AgentGpuProcess[] = procs.flatMap((p) => {
        const command = readCmdline(p.pid, opts.hostProc);
        // rocm-smi --showpids regularly returns an empty process_name
        // field (driver build / permissions dependent — most visible
        // when the hub runs in a container without CAP_SYS_PTRACE).
        // Fall back to argv[0] basename, then /proc/<pid>/comm — same
        // ladder the nvidia collector uses for [Not Found] / N/A rows.
        let name = p.process_name;
        if (
          !name ||
          name.toLowerCase() === "unknown" ||
          name === "[Not Found]" ||
          name === "-" ||
          name.toLowerCase() === "n/a"
        ) {
          name = resolveProcessName(p.pid, opts.hostProc) ?? "";
        }
        const llm = classifyLLM(command, opts.llmResolvers);
        // Stateful (delta-based) sampler — must be called exactly once
        // per pid per tick even though a multi-card pid below produces
        // several rows, so hoist it here rather than call it per-row.
        const cpuPct = cpuSampler.sample(p.pid);

        const devices = fdinfoRaw.get(p.pid);
        if (!devices || devices.length === 0) {
          if (isMultiCard && !multiCardFallbackWarned) {
            multiCardFallbackWarned = true;
            logger.warn(
              "proc",
              `pid ${p.pid}: no DRM fdinfo visibility on a multi-GPU AMD host, attributing to card0 (older kernel or restricted /proc access?)`,
            );
          }
          return [
            {
              pid: p.pid,
              process_name: name || "unknown",
              gpu_uuid: defaultUuid,
              used_memory: Math.floor(p.vram_used_bytes / 1048576),
              type: "C" as const,
              command,
              cpu_pct: cpuPct,
              // CU occupancy is the AMD equivalent of nvidia-smi's pmon
              // SM%: share of compute units this pid is using. Surface
              // it as gpu_pct so the UI can render a real number
              // instead of a permanent "—". Null when the driver
              // reports "unknown" (some kernels / non-root callers).
              gpu_pct: p.cu_occupancy,
              llm_runtime: llm.runtime,
              llm_model: llm.model,
            },
          ];
        }

        // One row per card this pid's fds are actually open on. VRAM
        // comes from fdinfo's own per-device counter — not rocm-smi's
        // single pid-wide aggregate — so the split is self-consistent.
        // cu_occupancy has no per-card breakdown available from
        // rocm-smi, so the same pid-wide value is repeated on every
        // row: an approximation, still strictly better than today's
        // everything-on-card0 behaviour.
        return devices.map((d) => ({
          pid: p.pid,
          process_name: name || "unknown",
          gpu_uuid: rocmUuidFromBus(d.pdev ?? undefined),
          used_memory: Math.floor(d.vramBytes / 1048576),
          type: "C" as const,
          command,
          cpu_pct: cpuPct,
          gpu_pct: p.cu_occupancy,
          llm_runtime: llm.runtime,
          llm_model: llm.model,
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
        const llm = classifyLLM(command, opts.llmResolvers);
        const cpuPct = cpuSampler.sample(pid); // once per pid per tick
        for (const usage of devices) {
          const { gpuPct, type } = fdinfoSampler.sample(pid, usage);
          enrichedFromFdinfo.push({
            pid,
            process_name: name,
            gpu_uuid: rocmUuidFromBus(usage.pdev ?? undefined),
            used_memory: Math.floor(usage.vramBytes / 1048576),
            type,
            command,
            cpu_pct: cpuPct,
            gpu_pct: gpuPct,
            llm_runtime: llm.runtime,
            llm_model: llm.model,
          });
        }
      }

      const enriched = [...enrichedFromRocm, ...enrichedFromFdinfo];
      cpuSampler.retain(new Set(enriched.map((p) => p.pid)));
      fdinfoSampler.retain(new Set(fdinfoRaw.keys()));
      opts.onSnapshot({
        tsEpoch: Math.floor(Date.now() / 1000),
        processes: enriched,
      });
    } finally {
      inflight = false;
    }
  }

  return {
    available(): boolean {
      return checkRocmSmi();
    },
    start(): void {
      if (timer) return;
      if (!checkRocmSmi()) {
        logger.warn(
          "proc",
          `rocm-smi not available at ${opts.rocmSmiPath} — ROCm process collector disabled`,
        );
        return;
      }
      logger.success(
        "proc",
        `ROCm process collector started (tick=${tickMs}ms, hostProc=${opts.hostProc})`,
      );
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
