import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';

// PATH lookup is restricted to a fixed allowlist of system directories
// (Sonar S4036). The NVIDIA Container Toolkit injects nvidia-smi under
// /usr/bin in the runtime image, and bare-metal installs land in the
// same directory tree. We keep this conservative and never inherit the
// caller's PATH so a malicious working directory cannot shadow the
// binary with a script of the same name.
const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function safeEnv(): NodeJS.ProcessEnv {
  // Strip PATH from the caller's env, then re-inject the locked-down
  // allowlist. Other variables (LANG, NVIDIA_VISIBLE_DEVICES, ...) are
  // preserved because nvidia-smi relies on some of them.
  const { PATH: _ignored, ...rest } = process.env;
  return { ...rest, PATH: SAFE_PATH };
}

export function spawnNvidiaSmi(args: string[]): ChildProcess {
  return spawn('nvidia-smi', args, { env: safeEnv() });
}

export function spawnSyncNvidiaSmi(args: string[], timeoutMs: number): SpawnSyncReturns<string> {
  return spawnSync('nvidia-smi', args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: safeEnv(),
  });
}
