// WebSocket ingest path for remote agents (multi-host jalon 3).
//
// Auth model (cf. Docs/MULTI_HOST_PLAN.md §3):
//  - token + host_id arrive as query string params at handshake
//  - host_id must NOT equal LOCAL_HOST_ID (self-loop guard)
//  - hub looks up the host by id (kind must be 'agent', not 'disabled')
//  - bcrypt.compare against the stored hash
//  - after handshake, the session's host_id is authoritative — any
//    host_id field present in incoming frames is IGNORED to defeat
//    the "compromised agent A publishes as host B" attack
//
// The rate limit (RATE_LIMIT_PER_SEC) is per-session; an offending
// agent gets 1008 Policy Violation and must reconnect with backoff.

import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import bcrypt from 'bcryptjs';
import { HostsRepo, LOCAL_HOST_ID, type HostRecord } from '../database/models/Host.js';
import { metricsBus } from './_metricsBus.js';
import { logger } from '../utils/logger.js';
import type { GpuSample } from './_nvidiaParsers.js';
import { agentProcessStore } from './agentProcessStore.js';
import type { GpuProcess } from './processCollector.js';

const RATE_LIMIT_PER_SEC = 100;
const LAST_SEEN_THROTTLE_MS = 1000;
const PROTOCOL_VER = 1;

interface HelloFrame {
  type: 'hello';
  host_id: string;
  agent_version?: string;
  protocol_ver?: number;
  hostname?: string;
  capabilities?: { gpu?: boolean; system?: boolean; temps?: boolean; processes?: boolean };
}

interface SampleFrame {
  type: 'sample';
  ts_epoch?: number;
  samples: GpuSample[];
}

interface PingFrame {
  type: 'ping';
  ts_epoch?: number;
}

interface ProcessFrame {
  type: 'processes';
  ts_epoch?: number;
  processes: GpuProcess[];
}

type IncomingFrame = HelloFrame | SampleFrame | PingFrame | ProcessFrame | { type: string; [k: string]: unknown };

/**
 * Look up the host that owns this token + claimed id. Bcrypt comparison
 * is intentionally per-handshake (typically once per agent restart);
 * if benchmarks show steady-state pain at scale we'll add an LRU here
 * per Docs/MULTI_HOST_PLAN.md §13.1.1.
 */
export async function authenticateAgent(token: string, claimedHostId: string): Promise<HostRecord | null> {
  if (!token || !claimedHostId) return null;
  if (claimedHostId === LOCAL_HOST_ID) return null;
  const host = HostsRepo.findById(claimedHostId);
  if (!host) return null;
  if (host.kind !== 'agent') return null;
  if (host.status === 'disabled') return null;
  if (!host.token_hash) return null;
  const ok = await bcrypt.compare(token, host.token_hash);
  return ok ? host : null;
}

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn('agent', 'send failed:', (err as Error).message);
  }
}

/**
 * Returns the WSS in noServer mode. The HTTP `upgrade` event is
 * dispatched centrally in index.ts (see gpuStreamWS for the rationale).
 */
export function setupAgentIngestWS(hubVersion: string): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    handleConnection(ws, req, hubVersion).catch((err) => {
      logger.error('agent', 'connection handler crashed:', (err as Error).message);
      try { ws.close(1011, 'server error'); } catch { /* ignore */ }
    });
  });

  logger.success('agent', 'Agent WebSocket ready on /agent');
  return wss;
}

async function handleConnection(ws: WebSocket, req: IncomingMessage, hubVersion: string): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost');
  const token = url.searchParams.get('token') || '';
  const claimedHostId = url.searchParams.get('host_id') || '';

  const host = await authenticateAgent(token, claimedHostId);
  if (!host) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  logger.success('agent', `Agent connected: ${host.id} (label=${host.label})`);

  safeSend(ws, { type: 'welcome', hub_version: hubVersion, protocol_ver: PROTOCOL_VER, tick_ms: 1000 });

  HostsRepo.markSeen(host.id);
  metricsBus.emit('host_status', {
    host_id: host.id,
    status: 'online',
    last_seen: Math.floor(Date.now() / 1000),
  });

  let lastSeenWroteAt = Date.now();
  const messageWindow: number[] = [];

  ws.on('message', (data) => {
    const now = Date.now();

    messageWindow.push(now);
    while (messageWindow.length > 0 && now - messageWindow[0] > 1000) messageWindow.shift();
    if (messageWindow.length > RATE_LIMIT_PER_SEC) {
      logger.warn('agent', `Rate limit exceeded for ${host.id}, closing`);
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    let frame: IncomingFrame;
    try {
      frame = JSON.parse(data.toString()) as IncomingFrame;
    } catch {
      logger.warn('agent', `Bad JSON from ${host.id}`);
      return;
    }

    dispatchFrame(ws, host, frame);

    if (now - lastSeenWroteAt > LAST_SEEN_THROTTLE_MS) {
      HostsRepo.markSeen(host.id);
      lastSeenWroteAt = now;
    }
  });

  ws.on('close', () => {
    logger.info('agent', `Agent disconnected: ${host.id} (label=${host.label})`);
    // Don't flip offline here — the watchdog handles transient drops
    // so a 200ms blip during reconnect doesn't toggle the UI dot.
  });
  ws.on('error', (err) => logger.warn('agent', `Socket error from ${host.id}:`, err.message));
}

function dispatchFrame(ws: WebSocket, host: HostRecord, frame: IncomingFrame): void {
  switch (frame.type) {
    case 'hello':
      handleHello(host, frame as HelloFrame);
      return;
    case 'sample':
      handleSample(host, frame as SampleFrame);
      return;
    case 'ping':
      safeSend(ws, { type: 'pong', ts_epoch: Math.floor(Date.now() / 1000) });
      return;
    case 'processes':
      handleProcesses(host, frame as ProcessFrame);
      return;
    case 'system':
    case 'temps':
      // Reserved for jalon 5+. Accept as heartbeat (already drove
      // the throttled markSeen above) but don't dispatch on the bus yet.
      return;
    default:
      logger.warn('agent', `Unknown frame type from ${host.id}: ${frame.type}`);
  }
}

function handleProcesses(host: HostRecord, frame: ProcessFrame): void {
  if (!Array.isArray(frame.processes)) return;
  // Empty list is a legitimate signal ("no GPU processes right now") —
  // we keep it so a stale snapshot clears as soon as the host idles.
  agentProcessStore.set(host.id, {
    ts: frame.ts_epoch ?? Math.floor(Date.now() / 1000),
    processes: frame.processes,
  });
}

function handleHello(host: HostRecord, frame: HelloFrame): void {
  if (frame.host_id !== host.id) {
    // Session was authenticated; the frame's host_id mismatch is
    // either a bug in the agent or an attempt to confuse the hub.
    // Log + ignore — don't tear down the session.
    logger.warn('agent', `hello: claimed ${frame.host_id} but session is ${host.id}`);
    return;
  }
  const caps = frame.capabilities ? JSON.stringify(frame.capabilities) : null;
  HostsRepo.update(host.id, {
    hostname: frame.hostname ?? host.hostname,
    agent_version: frame.agent_version ?? host.agent_version,
    capabilities: caps ?? host.capabilities,
    protocol_ver: frame.protocol_ver ?? host.protocol_ver,
  });
}

function handleSample(host: HostRecord, frame: SampleFrame): void {
  if (!Array.isArray(frame.samples) || frame.samples.length === 0) return;
  // The session host_id is authoritative — any host_id in the frame
  // payload is dropped on the floor. Security invariant (§3 of plan).
  metricsBus.emit('sample', { host_id: host.id, samples: frame.samples });
}
