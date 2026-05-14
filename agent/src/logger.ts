// Minimal logger for the agent — same visual style as the hub
// (timestamp + level + tag + message) so users can tail both side
// by side without cognitive overhead.

type Level = 'debug' | 'info' | 'warn' | 'error' | 'success';

const LEVEL_RANK: Record<Level, number> = {
  debug: 0,
  info: 1,
  success: 1,
  warn: 2,
  error: 3,
};

function envLevel(): Level {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

const MIN = LEVEL_RANK[envLevel()];

function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function prefix(level: Level, tag: string): string {
  return `[${ts()}] [${level.toUpperCase()}] [${tag}]`;
}

function emit(level: Level, tag: string, ...args: unknown[]): void {
  if (LEVEL_RANK[level] < MIN) return;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${prefix(level, tag)} ${args.map(String).join(' ')}\n`);
}

export const logger = {
  debug: (tag: string, ...args: unknown[]) => emit('debug', tag, ...args),
  info: (tag: string, ...args: unknown[]) => emit('info', tag, ...args),
  warn: (tag: string, ...args: unknown[]) => emit('warn', tag, ...args),
  error: (tag: string, ...args: unknown[]) => emit('error', tag, ...args),
  success: (tag: string, ...args: unknown[]) => emit('success', tag, ...args),
};
