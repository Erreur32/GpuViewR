// Long-running `powershell.exe` loop shared by the Windows PDH
// collectors (GPU samples + GPU processes). The script prints one JSON
// line per tick; this module owns the spawn, the line splitting and the
// respawn-on-exit, so each collector only has to parse its payload.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../logger.js';

export type PsLoopOptions = Readonly<{
  /** Log tag + prefix, e.g. 'gpu' / 'pdh'. */
  tag: string;
  label: string;
  script: string;
  onLine: (line: string) => void;
}>;

export interface PsLoopHandle {
  start(): void;
  stop(): void;
}

const RESPAWN_DELAY_MS = 3_000;

export function createPsLoop(opts: PsLoopOptions): PsLoopHandle {
  let child: ChildProcessWithoutNullStreams | null = null;
  let started = false;
  let buf = '';

  function spawnPs(): void {
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', opts.script,
      ], { windowsHide: true });
    } catch (err) {
      logger.error(opts.tag, `${opts.label}: powershell spawn threw: ${(err as Error).message}`);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) opts.onLine(line);
        nl = buf.indexOf('\n');
      }
    });
    child.stderr.on('data', (d) => {
      const msg = d.toString('utf8').trim();
      if (msg) logger.debug(opts.tag, `${opts.label} stderr: ${msg.slice(0, 200)}`);
    });
    child.on('error', (err) => logger.error(opts.tag, `${opts.label}: powershell error: ${err.message}`));
    child.on('close', (code) => {
      child = null;
      buf = '';
      if (started) {
        logger.warn(opts.tag, `${opts.label}: powershell exited (code=${code}), respawning in 3 s`);
        setTimeout(() => { if (started) spawnPs(); }, RESPAWN_DELAY_MS).unref();
      }
    });
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      spawnPs();
    },
    stop(): void {
      started = false;
      if (child) {
        try { child.kill(); } catch { /* already gone */ }
        child = null;
      }
      buf = '';
    },
  };
}
