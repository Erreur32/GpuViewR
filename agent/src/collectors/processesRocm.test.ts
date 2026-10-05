import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FDINFO_MIN_AGE_MS } from "./processesAmdgpuFdinfo.js";
import { amdgpuBusIds, createRocmProcessCollector, createRocmSmiCache } from "./processesRocm.js";
import { busFromLocation, kfdAvailable, readKfdGpuBuses, readKfdProcesses } from "./kfdSysfs.js";
import type { ProcessSnapshot } from "./processes.js";

async function fakeCard(drm: string, name: string, uevent: string): Promise<void> {
  await mkdir(join(drm, name, "device"), { recursive: true });
  await writeFile(join(drm, name, "device", "uevent"), uevent);
}

test("amdgpuBusIds: amdgpu cards only, connectors and other drivers skipped", async () => {
  const drm = await mkdtemp(join(tmpdir(), "gv-drm-"));
  await fakeCard(drm, "card1", "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:C5:00.0\n");
  await fakeCard(drm, "card0", "DRIVER=i915\nPCI_SLOT_NAME=0000:00:02.0\n");
  await fakeCard(drm, "card1-DP-1", "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:c5:00.0\n");
  assert.deepEqual(amdgpuBusIds(drm), ["0000:c5:00.0"]);
  assert.deepEqual(amdgpuBusIds(join(drm, "missing")), []);
});

test("rocm process collector: lists a Vulkan client from fdinfo without rocm-smi", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gv-nosmi-"));
  const drm = join(root, "drm");
  await fakeCard(drm, "card1", "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:c5:00.0\n");
  const proc = join(root, "proc");
  await mkdir(join(proc, "2000", "fdinfo"), { recursive: true });
  await writeFile(join(proc, "2000", "status"), "Name:\tllama-server\nPPid:\t1\n");
  await writeFile(join(proc, "2000", "comm"), "llama-server\n");
  await writeFile(join(proc, "2000", "cmdline"), "/app/llama-server\0-hf\0unsloth/Qwen3-8B-GGUF:Q4_K_M\0");
  await writeFile(
    join(proc, "2000", "fdinfo", "4"),
    "drm-driver:\tamdgpu\ndrm-pdev:\t0000:c5:00.0\ndrm-memory-vram:\t1048576 KiB\ndrm-engine-gfx:\t0 ns\ndrm-engine-compute:\t5000 ns\n",
  );

  // Fake clock: fdinfo is only read for pids seen for FDINFO_MIN_AGE_MS.
  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const snaps: ProcessSnapshot[] = [];
  const collector = createRocmProcessCollector({
    rocmSmiPath: join(root, "no-rocm-smi"),
    kfdRoot: join(root, "no-kfd"),
    sysClassDrm: drm,
    hostProc: proc,
    tickMs: 1_000,
    onSnapshot: (s) => snaps.push(s),
  });
  t.after(() => collector.stop());
  assert.equal(collector.available(), true);
  collector.start();
  for (let i = 0; i <= FDINFO_MIN_AGE_MS / 1_000 + 1; i++) {
    t.mock.timers.tick(1_000);
    await Promise.resolve();
  }

  const row = snaps.at(-1)?.processes.find((p) => p.pid === 2000);
  assert.ok(row, "llama-server listed");
  assert.equal(row.gpu_uuid, "ROCm-0000_c5_00_0");
  assert.equal(row.used_memory, 1024);
  assert.equal(row.llm_runtime, "llamacpp");
  assert.equal(row.llm_model, "Qwen3-8B-GGUF:Q4_K_M");
});

test("rocm process collector: unavailable with neither rocm-smi nor an amdgpu card", async () => {
  const root = await mkdtemp(join(tmpdir(), "gv-nosmi-"));
  const collector = createRocmProcessCollector({
    rocmSmiPath: join(root, "no-rocm-smi"),
    kfdRoot: join(root, "no-kfd"),
    sysClassDrm: join(root, "drm"),
    hostProc: join(root, "proc"),
    tickMs: 1_000,
    onSnapshot: () => {},
  });
  assert.equal(collector.available(), false);
});

test("createRocmSmiCache: runs rocm-smi once per refresh window", async () => {
  let runs = 0;
  const get = createRocmSmiCache(async () => `out${++runs}`, 10_000);
  assert.equal(await get(0), "out1");
  assert.equal(await get(2_000), "out1"); // next 2 s ticks reuse it
  assert.equal(await get(9_999), "out1");
  assert.equal(await get(10_000), "out2");
  assert.equal(runs, 2);
});

/** Fake /sys/class/kfd/kfd: CPU node 0, GPU node 1 (gpu_id 64506 on
 *  0000:c5:00.0, location_id 50432), and the given pids' vram files. */
async function fakeKfd(root: string, pids: Record<string, number>): Promise<string> {
  const kfd = join(root, "kfd");
  for (const [node, gpuId, location] of [["0", 0, 0], ["1", 64506, 50432]] as const) {
    await mkdir(join(kfd, "topology", "nodes", node), { recursive: true });
    await writeFile(join(kfd, "topology", "nodes", node, "gpu_id"), `${gpuId}\n`);
    await writeFile(join(kfd, "topology", "nodes", node, "properties"), `simd_count 80\nlocation_id ${location}\ndomain 0\n`);
  }
  await mkdir(join(kfd, "proc"), { recursive: true });
  for (const [pid, bytes] of Object.entries(pids)) {
    await mkdir(join(kfd, "proc", pid), { recursive: true });
    await writeFile(join(kfd, "proc", pid, "vram_64506"), `${bytes}\n`);
    await writeFile(join(kfd, "proc", pid, "pasid"), "21281\n");
  }
  return kfd;
}

test("busFromLocation: KFD location_id to a PCI bus id", () => {
  assert.equal(busFromLocation(0, 50432), "0000:c5:00.0"); // Jarvis
  assert.equal(busFromLocation(1, (0x03 << 8) | (0x1f << 3) | 7), "0001:03:1f.7");
});

test("readKfdProcesses: Jarvis layout, per-card VRAM keyed by bus", async () => {
  const root = await mkdtemp(join(tmpdir(), "gv-kfd-"));
  const kfd = await fakeKfd(root, { "160210": 3883843584 });
  const buses = readKfdGpuBuses(kfd);
  assert.deepEqual([...buses], [[64506, "0000:c5:00.0"]]);
  assert.deepEqual(readKfdProcesses(kfd, buses), [{ pid: 160210, vramByBus: new Map([["0000:c5:00.0", 3883843584]]) }]);
  assert.equal(kfdAvailable(kfd), true);
  assert.equal(kfdAvailable(join(root, "missing")), false);
  assert.deepEqual(readKfdProcesses(join(root, "missing"), buses), []);
});

test("rocm process collector: KFD pid from sysfs without any DRM fd, no rocm-smi", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gv-kfdcol-"));
  const drm = join(root, "drm");
  await fakeCard(drm, "card1", "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:c5:00.0\n");
  const proc = join(root, "proc");
  await mkdir(join(proc, "160210"), { recursive: true });
  await writeFile(join(proc, "160210", "status"), "Name:\tllama-server\nPPid:\t1\n");
  await writeFile(join(proc, "160210", "comm"), "llama-server\n");
  await writeFile(join(proc, "160210", "cmdline"), "/usr/lib/ollama/llama-server\0--model\0/root/.ollama/models/blobs/sha256-5ee4\0");
  const kfd = await fakeKfd(root, { "160210": 3883843584 });

  t.mock.timers.enable({ apis: ["Date", "setInterval"] });
  const snaps: ProcessSnapshot[] = [];
  const collector = createRocmProcessCollector({
    rocmSmiPath: join(root, "no-rocm-smi"),
    kfdRoot: kfd,
    sysClassDrm: drm,
    hostProc: proc,
    tickMs: 1_000,
    onSnapshot: (s) => snaps.push(s),
  });
  t.after(() => collector.stop());
  assert.equal(collector.available(), true);
  collector.start();
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  await Promise.resolve();

  const row = snaps.at(-1)?.processes.find((p) => p.pid === 160210);
  assert.ok(row, "KFD runner listed");
  assert.equal(row.gpu_uuid, "ROCm-0000_c5_00_0");
  assert.equal(row.used_memory, 3703); // floor, like every other row
  assert.equal(row.process_name, "llama-server");
  assert.equal(row.llm_runtime, "ollama");
});
