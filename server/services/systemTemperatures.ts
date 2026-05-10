// Host thermal sensors. Reads /sys/class/hwmon (Linux) and exposes the
// values as °C. Returns an empty array on platforms that don't expose
// hwmon (macOS, Windows) or when the kernel doesn't ship temperature
// sensors — callers must treat an empty list as "feature unavailable".
import fs from 'node:fs';
import path from 'node:path';

export interface HostTempSensor {
  // hwmon driver name (e.g. coretemp, k10temp, nvme, acpitz). Multiple
  // sensors usually share a source — UI groups by this field.
  source: string;
  // Human-readable label when the kernel exposed one (tempN_label),
  // otherwise a synthetic "tempN" identifier.
  label: string;
  // Current reading in °C.
  valueC: number;
  // Optional thresholds from tempN_max / tempN_crit (also °C). null when
  // the sensor doesn't expose them.
  maxC: number | null;
  critC: number | null;
}

const HWMON_ROOT = '/sys/class/hwmon';

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

function parseMilliC(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.round(n / 100) / 10;
}

// Sanity window for a "live" reading. hwmon exposes every channel a
// driver declares — including unwired motherboard pins and virtual
// sensors — and the kernel does not validate them. Common artefacts:
//   - 0°C / -0.1°C  : channel never populated
//   - large negatives: stale/uninitialised register
//   - >150°C        : transient bus error or wrong scale
// Dropping them at the source keeps the UI from showing fake bars.
function isPlausibleTempC(c: number): boolean {
  return c >= 5 && c <= 150;
}

export function readHostTemperatures(): HostTempSensor[] {
  if (!fs.existsSync(HWMON_ROOT)) return [];

  let entries: string[];
  try {
    entries = fs.readdirSync(HWMON_ROOT);
  } catch {
    return [];
  }

  const out: HostTempSensor[] = [];
  for (const entry of entries) {
    const dir = path.join(HWMON_ROOT, entry);
    const source = safeRead(path.join(dir, 'name')) ?? entry;

    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }

    // Sort by the trailing index so temp1, temp2, ... come out in order.
    const tempFiles = files
      .filter((f) => /^temp\d+_input$/.test(f))
      .sort((a, b) => extractIdx(a) - extractIdx(b));

    for (const f of tempFiles) {
      const idx = extractIdx(f);
      const valueC = parseMilliC(safeRead(path.join(dir, f)));
      if (valueC === null) continue;
      // Skip phantom/unwired channels — see isPlausibleTempC.
      if (!isPlausibleTempC(valueC)) continue;
      const labelRaw = safeRead(path.join(dir, `temp${idx}_label`));
      const label = labelRaw && labelRaw.length > 0 ? labelRaw : `temp${idx}`;
      const maxC = parseMilliC(safeRead(path.join(dir, `temp${idx}_max`)));
      const critC = parseMilliC(safeRead(path.join(dir, `temp${idx}_crit`)));
      out.push({ source, label, valueC, maxC, critC });
    }
  }

  return out;
}

function extractIdx(name: string): number {
  const m = /^temp(\d+)_/.exec(name);
  return m ? Number.parseInt(m[1], 10) : 0;
}
