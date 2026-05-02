import os from 'node:os';
import net from 'node:net';

const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  red: '\x1b[31m',
};

export function getNetworkIP(): string | null {
  const interfaces = os.networkInterfaces();
  // Prefer common LAN interfaces first
  const order = ['eth0', 'en0', 'wlan0', 'wlp', 'enp', 'ens', 'eno'];
  const names = Object.keys(interfaces);
  names.sort((a, b) => {
    const ai = order.findIndex((p) => a.startsWith(p));
    const bi = order.findIndex((p) => b.startsWith(p));
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  for (const name of names) {
    if (name.startsWith('docker') || name.startsWith('br-') || name.startsWith('veth') || name.startsWith('virbr')) continue;
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

/** Resolve the IP we should print in the banner (host LAN > container LAN > localhost). */
export function getDisplayIP(): string {
  return process.env.HOST_IP || getNetworkIP() || 'localhost';
}

/** Visible width that accounts for ANSI codes and emojis (each emoji ~ 2 columns). */
function visibleLen(s: string): number {
  const ansi = /\x1b\[[0-9;]*m/g;
  const cleaned = s.replace(ansi, '');
  const emojiRe = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
  const emojis = cleaned.match(emojiRe)?.length ?? 0;
  return cleaned.replace(emojiRe, '').length + emojis * 2;
}

export interface BannerInput {
  title: string;
  subtitle: string;
  version: string;
  envLabel: string;
  containerName: string;
  frontendWeb: string;
  frontendLocal: string;
  backendApi: string;
  websocket: string;
  features: string[];
}

export function renderBanner(b: BannerInput): string {
  const labelWidth = Math.max('Frontend WEB'.length, 'Frontend Local'.length, 'Backend API'.length, 'WebSocket'.length);
  const pad = (s: string) => s.padEnd(labelWidth);

  const rows = [
    `📦 Container:            ${b.containerName}`,
    `🌐 ${pad('Frontend WEB')}: ${b.frontendWeb}`,
    `💻 ${pad('Frontend Local')}: ${b.frontendLocal}`,
    `🔌 ${pad('Backend API')}: ${b.backendApi}/api/health`,
    `🔗 ${pad('WebSocket')}: ${b.websocket}`,
  ];
  const featureRows = ['Features:', ...b.features.map((f) => `✓ ${f}`)];

  const longest = Math.max(
    visibleLen(b.title),
    visibleLen(b.subtitle),
    visibleLen(b.envLabel),
    ...rows.map((r) => visibleLen(r) + 2),
    ...featureRows.map((r) => visibleLen(r) + 2),
  );
  const width = Math.max(longest + 4, 64);

  const center = (s: string, color: string) => {
    const len = visibleLen(s);
    const left = Math.max(Math.floor((width - len) / 2), 1);
    const right = Math.max(width - left - len, 0);
    return `${C.bright}${C.cyan}║${C.reset}${' '.repeat(left)}${color}${s}${C.reset}${' '.repeat(right)}${C.bright}${C.cyan}║${C.reset}`;
  };
  const left = (s: string, color: string) => {
    const len = visibleLen(s);
    const right = Math.max(width - len - 2, 0);
    return `${C.bright}${C.cyan}║${C.reset} ${color}${s}${C.reset}${' '.repeat(right)}${C.bright}${C.cyan}║${C.reset}`;
  };

  const top = `${C.bright}${C.cyan}╔${'═'.repeat(width)}╗${C.reset}`;
  const sep = `${C.bright}${C.cyan}╠${'═'.repeat(width)}╣${C.reset}`;
  const bot = `${C.bright}${C.cyan}╚${'═'.repeat(width)}╝${C.reset}`;
  const empty = `${C.bright}${C.cyan}║${' '.repeat(width)}║${C.reset}`;

  const lines: string[] = [];
  lines.push(top);
  lines.push(center(b.title, C.bright + C.white));
  lines.push(center(b.subtitle, C.dim));
  lines.push(sep);
  lines.push(center(b.envLabel, C.bright + C.green));
  lines.push(empty);
  lines.push(left(rows[0], C.cyan));   // container
  lines.push(sep);
  lines.push(left(rows[1], C.green));  // frontend web
  lines.push(left(rows[2], C.blue));   // frontend local
  lines.push(left(rows[3], C.yellow)); // backend
  lines.push(left(rows[4], C.magenta));// websocket
  lines.push(empty);
  lines.push(left(featureRows[0], C.bright + C.white));
  for (let i = 1; i < featureRows.length; i++) lines.push(left(featureRows[i], C.dim + C.green));
  lines.push(bot);
  return '\n' + lines.join('\n') + '\n';
}

/** Test if a TCP port is available on the given host. */
export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, host);
  });
}

/** Check the configured port; if taken, log a clear message and exit. */
export async function ensurePortFreeOrExit(port: number, label = 'backend'): Promise<void> {
  const free = await isPortFree(port);
  if (free) return;

  const msg = [
    '',
    `${C.bright}${C.red}╔${'═'.repeat(60)}╗${C.reset}`,
    `${C.bright}${C.red}║${C.reset}  Port ${C.bright}${C.yellow}${port}${C.reset} (${label}) is already in use.`,
    `${C.bright}${C.red}║${C.reset}  ${C.dim}Pick a free port via ${C.reset}${C.cyan}PORT=...${C.reset}${C.dim} in your .env${C.reset}`,
    `${C.bright}${C.red}║${C.reset}  ${C.dim}or stop the conflicting process:${C.reset}`,
    `${C.bright}${C.red}║${C.reset}    ${C.cyan}lsof -ti:${port} | xargs -r kill -9${C.reset}`,
    `${C.bright}${C.red}╚${'═'.repeat(60)}╝${C.reset}`,
    '',
  ].join('\n');
  // eslint-disable-next-line no-console
  console.error(msg);
  process.exit(2);
}
