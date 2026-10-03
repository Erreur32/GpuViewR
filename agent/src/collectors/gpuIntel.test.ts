import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverIntelCards, intelUuidFromBus, sumUsageByCard } from "./gpuIntel.js";
import { INTEL_DRIVERS, scanAmdgpuFdinfo } from "./processesAmdgpuFdinfo.js";
import { parseContainerCgroup } from "./_procTicks.js";

async function card(drm: string, name: string, uevent: string): Promise<void> {
  await mkdir(join(drm, name, "device"), { recursive: true });
  await writeFile(join(drm, name, "device", "uevent"), uevent);
}

test("discoverIntelCards: i915 and xe, other drivers and connectors skipped", async () => {
  const drm = await mkdtemp(join(tmpdir(), "gv-intel-"));
  await card(drm, "card0", "DRIVER=i915\nPCI_ID=8086:A7A0\nPCI_SLOT_NAME=0000:00:02.0\n");
  await card(drm, "card1", "DRIVER=xe\nPCI_ID=8086:E20B\nPCI_SLOT_NAME=0000:03:00.0\n");
  await card(drm, "card2", "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:c5:00.0\n");
  await card(drm, "card0-HDMI-A-1", "DRIVER=i915\n");
  const cards = await discoverIntelCards(drm);
  assert.deepEqual(cards.map((c) => [c.index, c.driver, c.pciBus, c.name]), [
    [0, "i915", "0000:00:02.0", "Intel Graphics [8086:a7a0]"],
    [1, "xe", "0000:03:00.0", "Intel Arc B580"],
  ]);
  assert.equal(intelUuidFromBus("0000:03:00.0"), "Intel-0000_03_00_0");
});

test("fdinfo: i915 and xe keys map to vram / gtt / busy time", async () => {
  const proc = await mkdtemp(join(tmpdir(), "gv-intel-proc-"));
  await mkdir(join(proc, "100", "fdinfo"), { recursive: true });
  await writeFile(join(proc, "100", "fdinfo", "5"), [
    "drm-driver:\ti915",
    "drm-pdev:\t0000:00:02.0",
    "drm-engine-render:\t2000000 ns",
    "drm-engine-video:\t999 ns",
    "drm-resident-system0:\t300 MiB",
    "drm-total-system0:\t400 MiB",
  ].join("\n"));
  await mkdir(join(proc, "200", "fdinfo"), { recursive: true });
  await writeFile(join(proc, "200", "fdinfo", "7"), [
    "drm-driver:\txe",
    "drm-pdev:\t0000:03:00.0",
    "drm-resident-vram0:\t2097152 KiB",
    "drm-resident-gtt:\t1048576",
  ].join("\n"));
  await mkdir(join(proc, "300", "fdinfo"), { recursive: true });
  await writeFile(join(proc, "300", "fdinfo", "3"), "drm-driver:\tamdgpu\ndrm-memory-vram:\t1 KiB\n");

  const scan = scanAmdgpuFdinfo(proc, undefined, Date.now(), INTEL_DRIVERS);
  assert.deepEqual([...scan.keys()].sort((a, b) => a - b), [100, 200]);
  const i915 = scan.get(100)![0];
  assert.equal(i915.gfxNs, 2_000_000);
  assert.equal(i915.vramBytes, 0);
  assert.equal(i915.gttBytes, 300 * 1024 * 1024);
  const xe = scan.get(200)![0];
  assert.equal(xe.vramBytes, 2 * 1024 ** 3);
  assert.equal(xe.gttBytes, 1_048_576);

  const byCard = sumUsageByCard(scan, "0000:00:02.0");
  assert.equal(byCard.get("0000:00:02.0")?.busyNs, 2_000_000);
  assert.equal(byCard.get("0000:03:00.0")?.vramBytes, 2 * 1024 ** 3);
});

test("parseContainerCgroup: docker, podman, k8s, host", () => {
  const id = "9692a12ef6f9b89c5797985a98e0a51ba37b9438bebb046ca90adc14674be037";
  assert.deepEqual(parseContainerCgroup(`0::/system.slice/docker-${id}.scope\n`), { engine: "docker", id: "9692a12ef6f9" });
  assert.deepEqual(parseContainerCgroup(`12:memory:/docker/${id}\n`), { engine: "docker", id: "9692a12ef6f9" });
  assert.deepEqual(parseContainerCgroup(`0::/user.slice/libpod-${id}.scope\n`), { engine: "podman", id: "9692a12ef6f9" });
  assert.deepEqual(parseContainerCgroup(`0::/kubepods/burstable/pod1/${id}\n`), { engine: "k8s", id: "9692a12ef6f9" });
  assert.equal(parseContainerCgroup("0::/system.slice/ollama.service\n"), null);
});
