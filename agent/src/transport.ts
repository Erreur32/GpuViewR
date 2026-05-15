// WebSocket client side of the agent. Connects to the hub's /agent
// path, performs the hello/welcome handshake, then drains the
// outbound buffer of pending samples on every reconnect.
//
// Design notes (cf. Docs/MULTI_HOST_PLAN.md §4):
//  - Reconnect uses exponential backoff (1s → 30s by default) with
//    ±20% jitter to avoid the thundering-herd when many agents
//    redial after a hub restart.
//  - Outbound samples that arrive while disconnected go into a ring
//    buffer capped at BUFFER_MAX entries (~1 h × 1 Hz × few GPUs).
//    On reconnect the buffer is flushed in order, then live frames
//    resume.
//  - The disk-persistence path (AGENT_BUFFER_PERSIST=1) is a stub
//    in jalon 4; the design lives in §4 of the plan but production
//    code will land with the v0.3.1 cycle.

import { WebSocket } from 'ws';
import { logger } from './logger.js';
import type { GpuSample } from '../../server/services/_nvidiaParsers.js';
import type { AgentGpuProcess } from './collectors/processes.js';
import type { AgentConfig } from './config.js';

const BUFFER_MAX = 3600;
const RECONNECT_MIN_MS = 1_000;
const PING_INTERVAL_MS = 15_000;
const AGENT_VERSION = '0.3.0';
const PROTOCOL_VER = 1;

interface SampleFrame {
  type: 'sample';
  ts_epoch: number;
  samples: GpuSample[];
}

interface ProcessFrame {
  type: 'processes';
  ts_epoch: number;
  processes: AgentGpuProcess[];
}

type BufferableFrame = SampleFrame | ProcessFrame;

type OutboundFrame = BufferableFrame | { type: 'hello' | 'ping'; [k: string]: unknown };

interface IncomingFrame {
  type: string;
  [k: string]: unknown;
}

export interface Transport {
  start(): void;
  stop(): void;
  enqueueSample(samples: GpuSample[]): void;
  enqueueProcesses(processes: AgentGpuProcess[]): void;
}

export function createTransport(config: AgentConfig): Transport {
  let ws: WebSocket | null = null;
  let reconnectDelayMs = RECONNECT_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  const buffer: BufferableFrame[] = [];

  function pushToBuffer(frame: BufferableFrame): void {
    buffer.push(frame);
    while (buffer.length > BUFFER_MAX) buffer.shift();
  }

  function flushBuffer(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    let drained = 0;
    while (buffer.length > 0 && ws.readyState === WebSocket.OPEN) {
      const frame = buffer.shift()!;
      sendRaw(frame);
      drained++;
    }
    if (drained > 0) logger.info('ws', `Replayed ${drained} buffered frame(s) after reconnect`);
  }

  function sendRaw(frame: OutboundFrame): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      logger.warn('ws', 'send failed:', (err as Error).message);
    }
  }

  function buildUrl(): string {
    const u = new URL(config.hubUrl);
    if (!u.pathname || u.pathname === '/') u.pathname = '/agent';
    u.searchParams.set('token', config.agentToken);
    u.searchParams.set('host_id', config.hostId);
    return u.toString();
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (reconnectTimer) return;
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // ±20%
    const delay = Math.min(reconnectDelayMs * jitter, config.reconnectMaxMs);
    logger.info('ws', `Reconnecting in ${Math.round(delay)}ms (buffered=${buffer.length})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, config.reconnectMaxMs);
  }

  function startPing(): void {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        sendRaw({ type: 'ping', ts_epoch: Math.floor(Date.now() / 1000) });
      }
    }, PING_INTERVAL_MS);
  }

  function stopPing(): void {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function sendHello(): void {
    sendRaw({
      type: 'hello',
      host_id: config.hostId,
      agent_version: AGENT_VERSION,
      protocol_ver: PROTOCOL_VER,
      hostname: process.env.HOSTNAME || null,
      capabilities: {
        gpu: config.features.gpu,
        system: config.features.system,
        temps: config.features.temps,
        processes: config.features.processes,
      },
    });
  }

  function handleIncoming(raw: string): void {
    let frame: IncomingFrame;
    try {
      frame = JSON.parse(raw);
    } catch {
      logger.warn('ws', `Bad JSON from hub`);
      return;
    }
    switch (frame.type) {
      case 'welcome': {
        logger.success('ws', `Hub welcomed us (hub_version=${frame.hub_version}, protocol_ver=${frame.protocol_ver})`);
        const hubProto = frame.protocol_ver as number | undefined;
        if (hubProto !== undefined && hubProto > PROTOCOL_VER) {
          logger.error('ws', `Hub speaks protocol_ver=${hubProto} > agent's ${PROTOCOL_VER}. Upgrade agent.`);
          // No cleanup needed: process.exit tears down the WS and the
          // hub will see the close as just another disconnection.
          process.exit(1);
        }
        sendHello();
        flushBuffer();
        break;
      }
      case 'pong':
        // No-op: presence of pong is the liveness signal.
        break;
      case 'config':
        // Reserved for future hub-driven tick rate changes; ignore in v0.3.
        break;
      default:
        logger.debug('ws', `Unknown frame type from hub: ${frame.type}`);
    }
  }

  function connect(): void {
    if (stopped) return;
    const url = buildUrl();
    logger.info('ws', `Connecting to ${url.replace(/token=[^&]+/, 'token=***')}`);
    const opts = config.tlsInsecure ? { rejectUnauthorized: false } : {};
    ws = new WebSocket(url, opts);
    ws.on('open', () => {
      logger.success('ws', 'Connection open');
      reconnectDelayMs = RECONNECT_MIN_MS;
      startPing();
    });
    ws.on('message', (data) => handleIncoming(data.toString()));
    ws.on('close', (code, reason) => {
      stopPing();
      const r = reason?.toString() || '';
      logger.warn('ws', `Connection closed (code=${code}${r ? `, reason=${r}` : ''})`);
      // 4001/1008 are auth or policy violations — exit, no retry.
      if (code === 4001 || code === 1008) {
        logger.error('ws', `Fatal close code ${code} — agent will exit. Check HOST_ID/AGENT_TOKEN.`);
        process.exit(1);
      }
      ws = null;
      scheduleReconnect();
    });
    ws.on('error', (err) => {
      logger.warn('ws', `Socket error: ${err.message}`);
      // Triggers 'close' which schedules reconnect.
    });
  }

  return {
    start(): void {
      stopped = false;
      connect();
    },
    stop(): void {
      stopped = true;
      stopPing();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try { ws.close(1000); } catch { /* ignore */ }
        ws = null;
      }
    },
    enqueueSample(samples: GpuSample[]): void {
      if (samples.length === 0) return;
      const frame: SampleFrame = {
        type: 'sample',
        ts_epoch: Math.floor(Date.now() / 1000),
        samples,
      };
      if (ws?.readyState === WebSocket.OPEN) {
        sendRaw(frame);
      } else {
        pushToBuffer(frame);
      }
    },
    enqueueProcesses(processes: AgentGpuProcess[]): void {
      // Empty snapshots are still meaningful — they tell the hub "no
      // processes right now" so a stale list clears. Don't drop them.
      const frame: ProcessFrame = {
        type: 'processes',
        ts_epoch: Math.floor(Date.now() / 1000),
        processes,
      };
      if (ws?.readyState === WebSocket.OPEN) {
        sendRaw(frame);
      } else {
        pushToBuffer(frame);
      }
    },
  };
}

/** Exposed for tests — verifies that pushing past BUFFER_MAX drops old entries. */
export const _TEST_HOOKS = { BUFFER_MAX };
