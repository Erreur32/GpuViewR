import { EventEmitter } from 'node:events';

export type LogLevel = 'info' | 'warn' | 'error' | 'success' | 'debug';

export interface LogEntry {
  ts: number;          // epoch ms
  level: LogLevel;
  scope: string;
  message: string;
}

const COLORS: Record<LogLevel, string> = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  success: '\x1b[32m',
  debug: '\x1b[90m',
};
const RESET = '\x1b[0m';

const MAX_BUFFER = 2000;
const buffer: LogEntry[] = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(50);

function ts(epoch: number): string {
  return new Date(epoch).toISOString().replace('T', ' ').slice(0, 19);
}

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return a.message;
      if (typeof a === 'object') {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(' ');
}

function push(level: LogLevel, scope: string, args: unknown[]): void {
  const entry: LogEntry = { ts: Date.now(), level, scope, message: format(args) };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

  const color = COLORS[level];
  // eslint-disable-next-line no-console
  console.log(`${color}[${ts(entry.ts)}] [${level.toUpperCase()}] [${scope}]${RESET}`, ...args);
  emitter.emit('log', entry);
}

export const logger = {
  info: (scope: string, ...args: unknown[]) => push('info', scope, args),
  warn: (scope: string, ...args: unknown[]) => push('warn', scope, args),
  error: (scope: string, ...args: unknown[]) => push('error', scope, args),
  success: (scope: string, ...args: unknown[]) => push('success', scope, args),
  debug: (scope: string, ...args: unknown[]) => {
    if (process.env.DEBUG) push('debug', scope, args);
  },

  /** Subscribe to live log entries */
  on(listener: (entry: LogEntry) => void): () => void {
    emitter.on('log', listener);
    return () => emitter.off('log', listener);
  },

  /** Read recent log entries with optional filtering */
  query(opts: {
    level?: LogLevel | 'all';
    scope?: string;
    search?: string;
    sinceTs?: number;
    untilTs?: number;
    limit?: number;
  } = {}): LogEntry[] {
    const limit = Math.min(2000, opts.limit ?? 500);
    const lvl = opts.level && opts.level !== 'all' ? opts.level : null;
    const scope = opts.scope?.toLowerCase();
    const search = opts.search?.toLowerCase();

    const out: LogEntry[] = [];
    for (let i = buffer.length - 1; i >= 0 && out.length < limit; i--) {
      const e = buffer[i];
      if (lvl && e.level !== lvl) continue;
      if (scope && !e.scope.toLowerCase().includes(scope)) continue;
      if (search && !e.message.toLowerCase().includes(search)) continue;
      if (opts.sinceTs && e.ts < opts.sinceTs) continue;
      if (opts.untilTs && e.ts > opts.untilTs) continue;
      out.push(e);
    }
    return out;
  },

  scopes(): string[] {
    const set = new Set<string>();
    for (const e of buffer) set.add(e.scope);
    return Array.from(set).sort();
  },
};
