// Resolve the underlying host's hostname even when the hub runs in a
// container. Inside Docker, os.hostname() returns the container ID
// (e.g. "48f38404d5f8") because the container has its own UTS
// namespace. The compose files already bind-mount the host's /proc
// read-only at /host/proc for the process collectors; we can read
// /host/proc/sys/kernel/hostname from there to get the real value.
//
// Bare-metal installs (no /host/proc) fall back to os.hostname() —
// which returns the right thing when there's no Docker boundary to
// cross.

import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';

const PROC_ROOT = process.env.HOST_PROC ?? '/proc';

/** Real OS hostname of the machine the hub runs on. Reads it from
 *  the bind-mounted host /proc when available, falls back to
 *  os.hostname() otherwise. Cached after the first call — hostname
 *  changes inside a running container would require a restart to
 *  surface anyway. */
let cached: string | null = null;

export function hostHostname(): string {
  if (cached !== null) return cached;
  try {
    const path = `${PROC_ROOT}/sys/kernel/hostname`;
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      if (value) {
        cached = value;
        return cached;
      }
    }
  } catch {
    // fall through to os.hostname()
  }
  cached = os.hostname() || 'localhost';
  return cached;
}
