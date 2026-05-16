// Resolve the underlying host's hostname even when the hub runs in a
// container. Inside Docker, os.hostname() returns the container ID
// (e.g. "9490fde69ed2") because the container owns its UTS namespace.
//
// /proc/sys/kernel/hostname is a pseudo-virtual file whose value
// follows the reading process's UTS namespace, not the procfs mount
// point — so bind-mounting /proc from the host does NOT necessarily
// surface the host's hostname (kernel-version dependent). We try
// several sources in order of reliability:
//
//   1. HUB_HOSTNAME env  — user override, beats everything.
//   2. /host/etc/hostname — static file, bind-mounted from the host
//                           in the compose files. Always reflects the
//                           real hostname when present.
//   3. /host/proc/sys/kernel/hostname — works on some kernels (older
//                           kernel/Docker), kept as a best-effort
//                           fallback.
//   4. os.hostname()      — last resort. On bare metal this is the
//                           correct value. In containers it's the
//                           container id.

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';

const PROC_ROOT = process.env.HOST_PROC ?? '/proc';
const HOST_ETC = process.env.HOST_ETC ?? '/host/etc';

let cached: string | null = null;

function readTrimmed(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const value = readFileSync(path, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export function hostHostname(): string {
  if (cached !== null) return cached;
  // 1. explicit override
  const override = (process.env.HUB_HOSTNAME ?? '').trim();
  if (override) {
    cached = override;
    return cached;
  }
  // 2. bind-mounted /etc/hostname (most reliable inside Docker)
  const fromEtc = readTrimmed(`${HOST_ETC}/hostname`);
  if (fromEtc) {
    cached = fromEtc;
    return cached;
  }
  // 3. bind-mounted /proc — works on some kernels
  const fromProc = readTrimmed(`${PROC_ROOT}/sys/kernel/hostname`);
  if (fromProc) {
    cached = fromProc;
    return cached;
  }
  // 4. last resort
  cached = os.hostname() || 'localhost';
  return cached;
}
