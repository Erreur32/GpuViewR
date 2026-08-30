import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFdinfoGpuSampler,
  scanAmdgpuFdinfo,
} from "./processesAmdgpuFdinfo.js";

/** Build a fake hostProc tree: hostProc/<pid>/fdinfo/<fd>. */
async function makeFakeProc(): Promise<string> {
  return mkdtemp(join(tmpdir(), "gpuviewr-fdinfo-"));
}

async function writeFdinfo(
  hostProc: string,
  pid: number,
  fd: string,
  text: string,
): Promise<void> {
  const dir = join(hostProc, String(pid), "fdinfo");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fd), text);
}

test("scanAmdgpuFdinfo: picks up an amdgpu fd with gfx/compute/vram", async () => {
  const root = await makeFakeProc();
  await writeFdinfo(
    root,
    1234,
    "5",
    "pos:\t0\n" +
      "flags:\t02\n" +
      "mnt_id:\t20\n" +
      "drm-driver:\tamdgpu\n" +
      "drm-pdev:\t0000:c5:00.0\n" +
      "drm-memory-vram:\t524288 KiB\n" +
      "drm-engine-gfx:\t1000000000 ns\n" +
      "drm-engine-compute:\t500000000 ns\n",
  );

  const result = scanAmdgpuFdinfo(root);
  assert.equal(result.size, 1);
  const usage = result.get(1234);
  assert.ok(usage);
  assert.equal(usage.pdev, "0000:c5:00.0");
  assert.equal(usage.vramBytes, 524288 * 1024);
  assert.equal(usage.gfxNs, 1_000_000_000);
  assert.equal(usage.computeNs, 500_000_000);
});

test("scanAmdgpuFdinfo: ignores non-amdgpu fds but keeps amdgpu ones for the same pid", async () => {
  const root = await makeFakeProc();
  await writeFdinfo(
    root,
    42,
    "3",
    "drm-driver:\ti915\n" +
      "drm-pdev:\t0000:00:02.0\n" +
      "drm-engine-render:\t999 ns\n",
  );
  await writeFdinfo(
    root,
    42,
    "7",
    "drm-driver:\tamdgpu\n" +
      "drm-pdev:\t0000:c5:00.0\n" +
      "drm-engine-gfx:\t200 ns\n",
  );

  const result = scanAmdgpuFdinfo(root);
  assert.equal(result.size, 1);
  const usage = result.get(42);
  assert.ok(usage);
  assert.equal(usage.pdev, "0000:c5:00.0");
  assert.equal(usage.gfxNs, 200);
});

test("scanAmdgpuFdinfo: pid with no fdinfo dir is skipped without throwing", async () => {
  const root = await makeFakeProc();
  await mkdir(join(root, "99"), { recursive: true }); // no fdinfo subdir
  const result = scanAmdgpuFdinfo(root);
  assert.equal(result.size, 0);
});

test("scanAmdgpuFdinfo: tolerates malformed lines and missing unit suffixes", async () => {
  const root = await makeFakeProc();
  await writeFdinfo(
    root,
    7,
    "1",
    "drm-driver:\tamdgpu\n" +
      "this line has no colon separator so it should be ignored\n" +
      "drm-engine-gfx:\t42\n" +
      "drm-memory-vram:\tnot-a-number\n",
  );

  const result = scanAmdgpuFdinfo(root);
  const usage = result.get(7);
  assert.ok(usage);
  assert.equal(usage.gfxNs, 42);
  assert.equal(usage.vramBytes, 0);
});

test("scanAmdgpuFdinfo: non-numeric pid directories are ignored", async () => {
  const root = await makeFakeProc();
  await writeFdinfo(
    root,
    NaN as unknown as number,
    "1",
    "drm-driver:\tamdgpu\n",
  );
  // Also plant a legit "self"-style non-numeric proc entry directly.
  await mkdir(join(root, "self", "fdinfo"), { recursive: true });
  await writeFile(join(root, "self", "fdinfo", "0"), "drm-driver:\tamdgpu\n");

  const result = scanAmdgpuFdinfo(root);
  assert.equal(result.size, 0);
});

test("createFdinfoGpuSampler: first sample has no baseline -> gpuPct null", () => {
  const sampler = createFdinfoGpuSampler();
  const { gpuPct, type } = sampler.sample(1, {
    pdev: "0000:c5:00.0",
    vramBytes: 0,
    gfxNs: 1000,
    computeNs: 0,
  });
  assert.equal(gpuPct, null);
  assert.equal(type, "G");
});

test("createFdinfoGpuSampler: type reflects cumulative gfx/compute usage", () => {
  const sampler = createFdinfoGpuSampler();
  assert.equal(
    sampler.sample(1, { pdev: null, vramBytes: 0, gfxNs: 0, computeNs: 0 })
      .type,
    null,
  );
  assert.equal(
    sampler.sample(2, { pdev: null, vramBytes: 0, gfxNs: 10, computeNs: 0 })
      .type,
    "G",
  );
  assert.equal(
    sampler.sample(3, { pdev: null, vramBytes: 0, gfxNs: 0, computeNs: 10 })
      .type,
    "C",
  );
  assert.equal(
    sampler.sample(4, { pdev: null, vramBytes: 0, gfxNs: 10, computeNs: 10 })
      .type,
    "G+C",
  );
});

test("createFdinfoGpuSampler: computes % busy from a real elapsed delta", async () => {
  const sampler = createFdinfoGpuSampler();
  sampler.sample(1, { pdev: null, vramBytes: 0, gfxNs: 0, computeNs: 0 });

  // dt is wall-clock (Date.now()), so give a real — if short — delay
  // to guarantee dt > 0 regardless of clock resolution, then feed a
  // known busy-ns delta and check the result is a sane percentage.
  await new Promise((r) => setTimeout(r, 20));
  const { gpuPct } = sampler.sample(1, {
    pdev: null,
    vramBytes: 0,
    gfxNs: 10_000_000, // 10ms of gfx busy time over >=20ms elapsed
    computeNs: 0,
  });
  assert.ok(gpuPct !== null);
  assert.ok(gpuPct > 0 && gpuPct <= 100);
});

test("createFdinfoGpuSampler: zero elapsed engine time -> 0%, not null", async () => {
  const sampler = createFdinfoGpuSampler();
  const usage = { pdev: null, vramBytes: 0, gfxNs: 0, computeNs: 0 };
  sampler.sample(1, usage);
  await new Promise((r) => setTimeout(r, 20));
  const { gpuPct } = sampler.sample(1, usage);
  assert.equal(gpuPct, 0);
});

test("createFdinfoGpuSampler: retain drops history for pids no longer present", () => {
  const sampler = createFdinfoGpuSampler();
  sampler.sample(1, { pdev: null, vramBytes: 0, gfxNs: 10, computeNs: 0 });
  sampler.retain(new Set());
  // After retain() drops pid 1's history, the next sample looks like a
  // fresh first observation again -> null.
  const { gpuPct } = sampler.sample(1, {
    pdev: null,
    vramBytes: 0,
    gfxNs: 20,
    computeNs: 0,
  });
  assert.equal(gpuPct, null);
});
