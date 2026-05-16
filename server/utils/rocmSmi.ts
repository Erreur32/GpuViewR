import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';

// Mirrors utils/nvidiaSmi.ts: locked-down PATH allowlist to defeat
// working-directory binary shadowing. rocm-smi on the canonical ROCm
// install is at /opt/rocm/bin/rocm-smi, so we explicitly include that
// path on top of the system dirs. Override the actual binary location
// with the ROCM_SMI_PATH env (config.rocmSmiPath) when ROCm lives
// somewhere else (e.g. /usr/local/rocm/, /opt/rocm-6.0/).
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/rocm/bin';

function safeEnv(): NodeJS.ProcessEnv {
  const { PATH: _ignored, ...rest } = process.env;
  return { ...rest, PATH: SAFE_PATH };
}

export function spawnRocmSmi(bin: string, args: string[]): ChildProcess {
  return spawn(bin, args, { env: safeEnv() });
}

export function spawnSyncRocmSmi(bin: string, args: string[], timeoutMs: number): SpawnSyncReturns<string> {
  return spawnSync(bin, args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: safeEnv(),
  });
}
