// Machine (chassis / CPU) fan read from /sys/class/hwmon. Used as a
// fallback when the GPU reports no fan of its own (APUs, passive cards),
// so the UI must flag it as "machine fan, not the GPU".
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// hwmon drivers that belong to a GPU or a drive, never to a machine fan.
const NOT_MACHINE = new Set(['amdgpu', 'radeon', 'nouveau', 'i915', 'xe', 'nvme', 'drivetemp']);

async function readNum(path: string): Promise<number | null> {
  try {
    const n = Number.parseInt(await readFile(path, 'utf8'), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Duty of one fan channel in %, or null when the channel has no spinning
 *  fan or no scale. Unwired headers read 0 RPM, so a stopped fan is
 *  skipped too. shortcut: a machine whose fans all stop shows N/A, not 0 %;
 *  fine for a fallback, revisit if users report zero-RPM chassis fans. */
async function channelPct(dir: string, n: string): Promise<number | null> {
  const [rpm, rpmMax, pwm, pwmMax] = await Promise.all([
    readNum(join(dir, `fan${n}_input`)),
    readNum(join(dir, `fan${n}_max`)),
    readNum(join(dir, `pwm${n}`)),
    readNum(join(dir, `pwm${n}_max`)),
  ]);
  if (rpm === null || rpm <= 0) return null;
  const pct = (v: number, max: number) => Math.max(0, Math.min(100, Math.round((v / max) * 100)));
  if (pwm !== null) return pct(pwm, pwmMax && pwmMax > 0 ? pwmMax : 255);
  if (rpmMax && rpmMax > 0) return pct(rpm, rpmMax);
  return null;
}

/** Highest machine fan duty in %, or null when no machine fan is exposed. */
export async function readMachineFanPct(hwmonRoot = '/sys/class/hwmon'): Promise<number | null> {
  let dirs: string[];
  try {
    dirs = await readdir(hwmonRoot);
  } catch {
    return null;
  }
  let best: number | null = null;
  for (const d of dirs) {
    const dir = join(hwmonRoot, d);
    let name: string;
    let files: string[];
    try {
      name = (await readFile(join(dir, 'name'), 'utf8')).trim();
      files = await readdir(dir);
    } catch {
      continue;
    }
    if (NOT_MACHINE.has(name)) continue;
    for (const f of files) {
      const m = /^fan(\d+)_input$/.exec(f);
      if (!m) continue;
      const p = await channelPct(dir, m[1]);
      if (p !== null && (best === null || p > best)) best = p;
    }
  }
  return best;
}
