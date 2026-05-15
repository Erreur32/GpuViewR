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

export interface AgentConfig {
  hubUrl: string;
  hostId: string;
  agentToken: string;
  tickMs: number;
  features: AgentFeatures;
  bufferPersist: boolean;
  agentLabel: string | null;
  gpuVendor: GpuVendor;
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
      const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
      const isPrivate = /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
      if (!isLoopback && !isPrivate) {
        process.stderr.write(`[WARN] HUB_URL uses ws:// against a non-private host (${host}). Use wss:// in production.\n`);
      }
    }
  } catch {
    process.stderr.write(`[FATAL] HUB_URL is not a valid URL: ${url}\n`);
    process.exit(1);
  }
}

export function loadConfig(): AgentConfig {
  const hubUrl = requiredEnv('HUB_URL');
  validateHubUrl(hubUrl);
  return {
    hubUrl,
    hostId: requiredEnv('HOST_ID'),
    agentToken: requiredEnv('AGENT_TOKEN'),
    tickMs: parseInt10('TICK_MS', 1000),
    features: parseFeatures(process.env.FEATURES || 'gpu,system,temps,processes'),
    bufferPersist: parseBool('AGENT_BUFFER_PERSIST', false),
    agentLabel: process.env.AGENT_LABEL?.trim() || null,
    gpuVendor: parseGpuVendor(process.env.GPU_VENDOR),
    nvidiaSmiPath: process.env.NVIDIA_SMI_PATH || 'nvidia-smi',
    rocmSmiPath: process.env.ROCM_SMI_PATH || 'rocm-smi',
    hostProc: process.env.HOST_PROC || '/host/proc',
    reconnectMaxMs: parseInt10('RECONNECT_MAX_MS', 30_000),
    tlsInsecure: parseBool('TLS_INSECURE', false),
    mockGpu: parseBool('MOCK_GPU', false),
  };
}
