import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMachineFanPct } from './machineFan.js';

async function hwmon(root: string, id: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  for (const [f, v] of Object.entries(files)) await writeFile(join(dir, f), `${v}\n`);
}

test('readMachineFanPct: highest spinning superio fan, GPU hwmon ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpuviewr-hwmon-'));
  await hwmon(root, 'hwmon0', { name: 'amdgpu', fan1_input: '3000', pwm1: '255' });
  // nct6775: fan1 at 40 %, fan2 unwired (0 RPM, pwm set), fan3 RPM-only with a max.
  await hwmon(root, 'hwmon1', {
    name: 'nct6775', fan1_input: '900', pwm1: '102',
    fan2_input: '0', pwm2: '255',
    fan3_input: '1500', fan3_max: '2500',
  });
  assert.equal(await readMachineFanPct(root), 60);
});

test('readMachineFanPct: null without machine fan (Strix Halo) or hwmon root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gpuviewr-hwmon-'));
  await hwmon(root, 'hwmon0', { name: 'amdgpu', temp1_input: '45000' });
  await hwmon(root, 'hwmon1', { name: 'k10temp', temp1_input: '50000' });
  assert.equal(await readMachineFanPct(root), null);
  assert.equal(await readMachineFanPct(join(root, 'missing')), null);
});
