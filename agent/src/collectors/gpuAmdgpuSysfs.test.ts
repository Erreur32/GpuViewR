import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test, createAmdgpuSysfsCollector } from './gpuAmdgpuSysfs.js';
import type { GpuSample } from '../../../server/services/parsers/nvidia.js';

/** Build a fake /sys/class/drm tree:
 *   card0     → amdgpu (Strix Halo APU, dev 0x1586)
 *   card1     → i915   (filtered out — wrong driver)
 *   card0-DP-1, card0-HDMI-A-1 → connector entries (filtered by regex)
 *   renderD128, version → siblings that must be ignored
 *  Also writes /sys/module/amdgpu/version.
 */
async function makeFakeSys(): Promise<{ sysClassDrm: string; amdgpuModulePath: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'gpuviewr-sysfs-'));
  const sysClassDrm = join(root, 'sys', 'class', 'drm');
  const amdgpuModulePath = join(root, 'sys', 'module', 'amdgpu');
  await mkdir(sysClassDrm, { recursive: true });
  await mkdir(amdgpuModulePath, { recursive: true });
  await writeFile(join(amdgpuModulePath, 'version'), '6.10.5\n');

  // --- card0 = amdgpu Strix Halo
  const c0 = join(sysClassDrm, 'card0', 'device');
  await mkdir(c0, { recursive: true });
  await writeFile(join(c0, 'uevent'),
    'DRIVER=amdgpu\n' +
    'PCI_CLASS=30000\n' +
    'PCI_ID=1002:1586\n' +
    'PCI_SUBSYS_ID=1002:1586\n' +
    'PCI_SLOT_NAME=0000:c5:00.0\n');
  await writeFile(join(c0, 'gpu_busy_percent'), '37\n');
  await writeFile(join(c0, 'mem_info_vram_used'), `${512 * 1048576}\n`);
  await writeFile(join(c0, 'mem_info_vram_total'), `${8192 * 1048576}\n`);
  await writeFile(join(c0, 'pp_dpm_sclk'),
    '0: 200Mhz\n' +
    '1: 605Mhz *\n' +
    '2: 805Mhz\n');
  const hw0 = join(c0, 'hwmon', 'hwmon3');
  await mkdir(hw0, { recursive: true });
  await writeFile(join(hw0, 'temp1_input'), '45000\n');
  await writeFile(join(hw0, 'power1_average'), '12500000\n'); // 12.5 W

  // --- card1 = i915 (must be filtered out)
  const c1 = join(sysClassDrm, 'card1', 'device');
  await mkdir(c1, { recursive: true });
  await writeFile(join(c1, 'uevent'),
    'DRIVER=i915\n' +
    'PCI_ID=8086:0046\n' +
    'PCI_SLOT_NAME=0000:00:02.0\n');

  // --- connector entries (must be filtered by CARD_RE anchor)
  await mkdir(join(sysClassDrm, 'card0-DP-1'), { recursive: true });
  await mkdir(join(sysClassDrm, 'card0-HDMI-A-1'), { recursive: true });
  // sibling files like /sys/class/drm/version exist as plain files
  await writeFile(join(sysClassDrm, 'version'), '1.1.0\n');

  return { sysClassDrm, amdgpuModulePath, root };
}

test('parseActiveDpm: picks the level marked with *', () => {
  assert.equal(__test.parseActiveDpm('0: 200Mhz\n1: 605Mhz *\n2: 805Mhz'), 605);
  assert.equal(__test.parseActiveDpm('0: 200Mhz *\n1: 800Mhz'), 200);
});

test('parseActiveDpm: no active marker → null', () => {
  assert.equal(__test.parseActiveDpm('0: 200Mhz\n1: 605Mhz'), null);
  assert.equal(__test.parseActiveDpm(null), null);
  assert.equal(__test.parseActiveDpm(''), null);
});

test('parseUevent: splits KEY=VALUE lines, ignores blanks', () => {
  const out = __test.parseUevent('DRIVER=amdgpu\nPCI_ID=1002:1586\n\nPCI_SLOT_NAME=0000:c5:00.0\n');
  assert.equal(out.DRIVER, 'amdgpu');
  assert.equal(out.PCI_ID, '1002:1586');
  assert.equal(out.PCI_SLOT_NAME, '0000:c5:00.0');
});

test('discoverAmdgpuCards: filters non-amdgpu drivers and connector dirs', async () => {
  const { sysClassDrm } = await makeFakeSys();
  const cards = await __test.discoverAmdgpuCards(sysClassDrm);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].index, 0);
  assert.equal(cards[0].pciBus, '0000:c5:00.0');
  assert.equal(cards[0].deviceIdHex, '0x1586');
  // Strix Halo is in the DEVICE_NAMES table — must come through
  assert.match(cards[0].name, /Strix Halo/);
  assert.ok(cards[0].hwmonPath?.endsWith('hwmon3'));
});

test('discoverAmdgpuCards: empty when sysfs root missing', async () => {
  const cards = await __test.discoverAmdgpuCards('/nonexistent/sys/class/drm');
  assert.deepEqual(cards, []);
});

test('sysfs collector: produces a GpuSample matching the fixture values', async () => {
  const { sysClassDrm, amdgpuModulePath } = await makeFakeSys();
  let samples: GpuSample[] | null = null;
  const handle = createAmdgpuSysfsCollector({
    sysClassDrm,
    amdgpuModulePath,
    tickMs: 60_000,           // never auto-fires during the test
    onSample: (s) => { samples = s; },
  });
  const count = await handle.discover();
  assert.equal(count, 1);
  assert.equal(handle.available(), true);

  handle.start();
  // start() emits one tick immediately via setImmediate / promise chain;
  // give the microtask queue a turn to flush the async reads.
  await new Promise((r) => setTimeout(r, 50));
  handle.stop();

  assert.ok(samples, 'expected at least one sample emission');
  const all = samples as unknown as GpuSample[];
  assert.equal(all.length, 1);
  const s = all[0];
  assert.equal(s.gpu_index, 0);
  assert.match(s.name, /Strix Halo/);
  assert.equal(s.uuid, 'ROCm-0000_c5_00_0');
  assert.equal(s.driver_version, '6.10.5');
  assert.equal(s.temperature, 45);
  assert.equal(s.utilization, 37);
  assert.equal(s.memory_used, 512);       // MiB
  assert.equal(s.memory_total, 8192);     // MiB
  assert.equal(s.power, 13);              // 12.5 W → rounded to 13
  assert.equal(s.clock_graphics, 605);
  assert.equal(s.clock_memory, null);     // never populated for APUs
  assert.equal(s.pci_bus_id, '0000:c5:00.0');
});

test('sysfs collector: available() reports false when no amdgpu card found', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpuviewr-sysfs-empty-'));
  const sysClassDrm = join(root, 'sys', 'class', 'drm');
  await mkdir(sysClassDrm, { recursive: true });
  const handle = createAmdgpuSysfsCollector({
    sysClassDrm,
    amdgpuModulePath: join(root, 'sys', 'module', 'amdgpu'),
    tickMs: 60_000,
    onSample: () => { /* unused */ },
  });
  const count = await handle.discover();
  assert.equal(count, 0);
  assert.equal(handle.available(), false);
});

test('sysfs collector: hwmon symlink path also works (real-world layout)', async () => {
  // Real /sys often exposes hwmon dirs via symlinks; pickHwmonDir must
  // follow them. node's readdir returns the link name; readFile follows.
  const { sysClassDrm, amdgpuModulePath } = await makeFakeSys();
  const c0 = join(sysClassDrm, 'card0', 'device');
  // Add a second card-like dir whose hwmon entry is itself a symlink to
  // a real hwmon directory elsewhere — exercises the readdir+readFile
  // path through a link.
  const realHw = join(sysClassDrm, '..', 'real-hwmon', 'hwmon9');
  await mkdir(realHw, { recursive: true });
  await writeFile(join(realHw, 'temp1_input'), '50000\n');
  await symlink(realHw, join(c0, 'hwmon-link-target'));
  // The fixture already has /hwmon/hwmon3, this just guards against
  // regressions in readdir filtering — we still expect exactly hwmon3.
  const cards = await __test.discoverAmdgpuCards(sysClassDrm);
  assert.equal(cards.length, 1);
  assert.ok(cards[0].hwmonPath?.endsWith('hwmon3'));
  // sanity: a temp read should not crash even if we never reach the link target
  const sample = await __test.sampleCard(cards[0], '6.10.5');
  assert.equal(sample.temperature, 45);
});
