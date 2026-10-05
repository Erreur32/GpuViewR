import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FDINFO_MIN_AGE_MS } from "./processesAmdgpuFdinfo.js";
import { amdgpuBusIds, createRocmProcessCollector, createRocmSmiCache } from "./processesRocm.js";
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
