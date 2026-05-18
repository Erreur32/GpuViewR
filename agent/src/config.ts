// Parse env into a validated config object. Required vars cause a
// fatal exit at boot (cf. Docs/MULTI_HOST_PLAN.md §12 — "soit l'agent
// tourne, soit il tourne pas"). Optional vars get sensible defaults.

export interface AgentFeatures {
  gpu: boolean;
  system: boolean;
  temps: boolean;
  processes: boolean;
}

export type GpuVendor = 'auto' | 'nvidia' | 'amd';

/** AMD-only knob. `auto` lets the agent prefer the cheap sysfs reader
 *  and fall back to rocm-smi if no amdgpu card is discovered under
 *  `/sys/class/drm/`. `sysfs` forces sysfs (fails fast if absent).
 *  `rocm-smi` keeps the legacy path that spawns rocm-smi every tick. */
export type GpuBackend = 'auto' | 'sysfs' | 'rocm-smi';

/** A single hub target. Multi-hub mode (v0.5+) lets one agent push
 *  to N hubs in parallel — each gets its own WS, its own host_id +
 *  token (the agent can be enrolled under different ids on different
 *  hubs), its own offline buffer. */
export interface HubTarget {
  url: string;
  hostId: string;
  token: string;
}

export interface AgentConfig {
  hubs: HubTarget[];
  tickMs: number;
  features: AgentFeatures;
  bufferPersist: boolean;
  agentLabel: string | null;
  gpuVendor: GpuVendor;
  gpuBackend: GpuBackend;
  sysClassDrm: string;
  processesTickMs: number;
  nvidiaSmiPath: string;
  rocmSmiPath: string;
  hostProc: string;
  reconnectMaxMs: number;
  tlsInsecure: boolean;
  mockGpu: boolean;
}

export function parseGpuVendor(raw: string | undefined): GpuVendor {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'nvidia' || v === 'amd' || v === 'auto') return v;
  return 'auto';
}

export function parseGpuBackend(raw: string | undefined): GpuBackend {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'sysfs' || v === 'rocm-smi' || v === 'auto') return v;
  return 'auto';
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    process.stderr.write(`[FATAL] Missing required env var: ${name}\n`);
    process.exit(1);
  }
  return v.trim();
}

function parseInt10(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] || '').toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return fallback;
}

export function parseFeatures(raw: string): AgentFeatures {
  const items = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    gpu: items.includes('gpu'),
    system: items.includes('system'),
    temps: items.includes('temps'),
    processes: items.includes('processes'),
  };
}

function validateHubUrl(url: string): void {
  // wss:// is always fine. ws:// only against loopback / RFC1918 — refuse
  // ws:// against public IPs (cf. plan §3). For agent simplicity we just
  // warn here; production deployments should use wss:// behind a proxy.
  try {
    const u = new URL(url);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      process.stderr.write(`[FATAL] HUB_URL must be ws:// or wss:// (got: ${u.protocol})\n`);
      process.exit(1);
    }
    if (u.protocol === 'ws:') {
      const host = u.hostname;
      // Only warn when the URL embeds a literal *public* IP — that's the
      // actual unsafe case. A bare hostname (docker alias like "hub",
      // LAN DNS name like "stats.lan") almost always resolves to a
      // private IP at runtime; without async DNS we can't verify that
      // here, and the previous check fired a false positive on every
      // docker-compose deploy. Trust the operator for hostnames.
      const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
      const isIpv6 = host.includes(':');
      if (isIpv4 || isIpv6) {
        const isLoopback = host === '127.0.0.1' || host === '::1';
        const isPrivate = /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
        if (!isLoopback && !isPrivate) {
          process.stderr.write(`[WARN] HUB_URL uses ws:// against a public IP (${host}). Use wss:// in production.\n`);
        }
      }
    }
  } catch {
    process.stderr.write(`[FATAL] HUB_URL is not a valid URL: ${url}\n`);
    process.exit(1);
  }
}

/** Parse hub targets from env. Two shapes:
 *
 *  - Multi-hub (v0.5+): HUB_URLS, HOST_IDS, AGENT_TOKENS as
 *    comma-separated lists, parallel arrays, same length.
 *  - Single-hub (backward-compat): HUB_URL + HOST_ID + AGENT_TOKEN.
 *
 *  At least one of the two MUST be configured or the agent exits.
 *  Mixed config (both shapes present) is rejected to avoid ambiguity.
 */
export function parseHubTargets(env: NodeJS.ProcessEnv = process.env): HubTarget[] {
  const hasMulti = !!(env.HUB_URLS && env.HUB_URLS.trim());
  const hasSingle = !!(env.HUB_URL && env.HUB_URL.trim());

  if (hasMulti && hasSingle) {
    process.stderr.write('[FATAL] HUB_URLS and HUB_URL are both set. Pick one — multi-hub mode (HUB_URLS) or single-hub (HUB_URL).\n');
    process.exit(1);
  }

  if (hasMulti) {
    const urls = (env.HUB_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ids = (env.HOST_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const tokens = (env.AGENT_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (urls.length === 0) {
      process.stderr.write('[FATAL] HUB_URLS is empty.\n');
      process.exit(1);
    }
    if (urls.length !== ids.length || urls.length !== tokens.length) {
      process.stderr.write(`[FATAL] HUB_URLS / HOST_IDS / AGENT_TOKENS arrays must have the same length (got ${urls.length}/${ids.length}/${tokens.length}).\n`);
      process.exit(1);
    }
    for (const url of urls) validateHubUrl(url);
    return urls.map((url, i) => ({ url, hostId: ids[i], token: tokens[i] }));
  }

  // Single-hub fallback.
  const url = requiredEnv('HUB_URL');
  validateHubUrl(url);
  return [{
    url,
    hostId: requiredEnv('HOST_ID'),
    token: requiredEnv('AGENT_TOKEN'),
  }];
}

export function loadConfig(): AgentConfig {
  const tickMs = parseInt10('TICK_MS', 1000);
  // Process collection is intentionally throttled relative to GPU samples.
  // rocm-smi --showpids spawns Python every call (~80-130 ms wall); running
  // it at the same cadence as the cheap sysfs reader would re-introduce the
  // exact CPU load the sysfs backend exists to eliminate. Default = 2×
  // tickMs (plancher 2 s) — halves the cost vs the legacy 1 Hz cadence
  // while keeping the process list visibly fresh.
  const processesDefault = Math.max(2_000, tickMs * 2);
  return {
    hubs: parseHubTargets(),
    tickMs,
    features: parseFeatures(process.env.FEATURES || 'gpu,system,temps,processes'),
    bufferPersist: parseBool('AGENT_BUFFER_PERSIST', false),
    agentLabel: process.env.AGENT_LABEL?.trim() || null,
    gpuVendor: parseGpuVendor(process.env.GPU_VENDOR),
    gpuBackend: parseGpuBackend(process.env.GPU_BACKEND),
    sysClassDrm: process.env.SYS_CLASS_DRM || '/sys/class/drm',
    processesTickMs: parseInt10('PROCESSES_TICK_MS', processesDefault),
    // Windows: Node's spawn() does NOT consult PATHEXT, so 'nvidia-smi'
    // alone fails with ENOENT even when the driver is installed. The
    // .exe is in C:\Windows\System32\ which is always in PATH, so the
    // bare filename with extension resolves correctly.
    nvidiaSmiPath: process.env.NVIDIA_SMI_PATH || (process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi'),
    rocmSmiPath: process.env.ROCM_SMI_PATH || 'rocm-smi',
    // /host/proc only exists on Linux. On Windows we don't read /proc
    // at all (process collector is skipped); empty string makes that
    // explicit and prevents the path from leaking into log lines.
    hostProc: process.env.HOST_PROC || (process.platform === 'win32' ? '' : '/host/proc'),
    reconnectMaxMs: parseInt10('RECONNECT_MAX_MS', 30_000),
    tlsInsecure: parseBool('TLS_INSECURE', false),
    mockGpu: parseBool('MOCK_GPU', false),
  };
}
