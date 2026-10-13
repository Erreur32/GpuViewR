// Who this machine is on the LAN: its real hostname and IPv4 addresses,
// reported to the hub (hello + every ping) so API clients can match a
// GpuViewR host with their own inventory when the labels differ.
//
// Docker agents run on a bridge network: os.hostname() is the container
// id and os.networkInterfaces() lists the container's eth0. So inside
// Docker:
//   - hostname: AGENT_HOSTNAME env, then the host's /etc/hostname
//     bind-mounted at $HOST_ETC/hostname, else null (never the
//     container id);
//   - IPs: read from the host's network namespace through the
//     bind-mounted procfs ($HOST_PROC/1/net/{fib_trie,route}): PID 1 of
//     the host procfs is the host init, whatever our own pid namespace.
//
// Loopback, Docker and virtual bridges are dropped (lo, docker*, br-*,
// veth*, virbr*, Hyper-V / VirtualBox / VMware host-only adapters,
// 127/8, 169.254/16, 172.17/16).

import { readFileSync } from "node:fs";
import os from "node:os";

export interface HostIdentity {
  hostname: string | null;
  ips: string[];
}

const EXCLUDED_IFACE = /^(lo\d*|docker\d*|br-|veth|virbr|cni|podman|flannel|cali|vEthernet \((WSL|Default Switch)|VirtualBox Host-Only|VMware Network Adapter)/i;
const MAX_IPS = 16;

export function isExcludedIface(name: string): boolean {
  return EXCLUDED_IFACE.test(name);
}

export function isExcludedIp(ip: string): boolean {
  return ip.startsWith("127.") || ip.startsWith("169.254.") || ip.startsWith("172.17.") || ip === "0.0.0.0";
}

function isIpv4(v: string): boolean {
  const parts = v.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** IPv4 in the little-endian form /proc/net/route prints (hex). */
function ipToLe(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((d << 24) | (c << 16) | (b << 8) | a) >>> 0;
}

function popcount(n: number): number {
  let bits = 0;
  for (let v = n >>> 0; v; v >>>= 1) bits += v & 1;
  return bits;
}

interface Route { iface: string; dest: number; mask: number }

export function parseProcRoute(text: string): Route[] {
  const routes: Route[] = [];
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    const dest = Number.parseInt(cols[1], 16);
    const mask = Number.parseInt(cols[7], 16);
    if (!Number.isFinite(dest) || !Number.isFinite(mask) || mask === 0) continue;
    routes.push({ iface: cols[0], dest: dest >>> 0, mask: mask >>> 0 });
  }
  return routes;
}

/** Local addresses of a /proc/net/fib_trie dump (`/32 host LOCAL` leaves). */
export function parseFibTrieLocal(text: string): string[] {
  const out = new Set<string>();
  let last: string | null = null;
  for (const line of text.split("\n")) {
    const leaf = /\|--\s+(\d+\.\d+\.\d+\.\d+)\s*$/.exec(line);
    if (leaf) {
      last = leaf[1];
      continue;
    }
    if (last && /\/32 host LOCAL/.test(line)) out.add(last);
  }
  return [...out];
}

/** LAN IPv4s from a host's fib_trie + route tables: each local address is
 *  tied to the interface of its most specific route to drop bridges. */
export function ipsFromProcNet(fibTrie: string, route: string): string[] {
  const routes = parseProcRoute(route);
  const ips: string[] = [];
  for (const ip of parseFibTrieLocal(fibTrie)) {
    if (!isIpv4(ip) || isExcludedIp(ip)) continue;
    const le = ipToLe(ip);
    let best: Route | null = null;
    for (const r of routes) {
      if ((le & r.mask) >>> 0 !== r.dest) continue;
      if (!best || popcount(r.mask) > popcount(best.mask)) best = r;
    }
    if (best && isExcludedIface(best.iface)) continue;
    ips.push(ip);
  }
  return ips;
}

export function ipsFromInterfaces(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): string[] {
  const ips: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (isExcludedIface(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !isExcludedIp(a.address)) ips.push(a.address);
    }
  }
  return ips;
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Printable name, <= 253 chars, or null. */
export function cleanHostname(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s || s.length > 253 || /[\s\p{Cc}]/u.test(s)) return null;
  return s;
}

export function collectHostIdentity(docker: boolean, env: NodeJS.ProcessEnv = process.env): HostIdentity {
  const hostProc = env.HOST_PROC || "/host/proc";
  const hostEtc = env.HOST_ETC || "/host/etc";
  const override = cleanHostname(env.AGENT_HOSTNAME);
  let hostname: string | null;
  let ips: string[];
  if (docker) {
    hostname = override ?? cleanHostname(readTrimmed(`${hostEtc}/hostname`));
    const fib = readTrimmed(`${hostProc}/1/net/fib_trie`);
    const route = readTrimmed(`${hostProc}/1/net/route`);
    // No host procfs mounted: our own interfaces are the container's.
    ips = fib && route ? ipsFromProcNet(fib, route) : [];
  } else {
    hostname = override ?? cleanHostname(os.hostname());
    ips = ipsFromInterfaces(os.networkInterfaces());
  }
  return { hostname, ips: [...new Set(ips)].slice(0, MAX_IPS) };
}
