import { WebSocketServer, WebSocket } from 'ws';
import { authService } from './authService.js';
import { metricsBus, type SampleEvent, type HostStatusEvent } from './_metricsBus.js';
import { LOCAL_HOST_ID } from '../database/models/Host.js';
import { alertService } from './alertService.js';
import { logger } from '../utils/logger.js';
import type { AlertEvent, AlertRule } from '../database/models/Alert.js';

/**
 * Returns the WebSocketServer in noServer mode. The HTTP `upgrade`
 * event is dispatched centrally in index.ts so multiple WS endpoints
 * (/ws/gpu + /agent) can coexist on the same http.Server — the `ws`
 * library's `path:` option is an anti-pattern when more than one
 * WSS attaches to the same server (the first one to handle 'upgrade'
 * rejects everything else with 400).
 */
export function setupGpuWebSocket(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const payload = authService.verifyToken(token);
    if (!payload) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    logger.debug('ws', `client connected (user=${payload.username})`);

    // Initial snapshot for the client = the local sidecar's latest
    // samples (if any). Remote agents' samples will arrive via the
    // metricsBus 'sample' subscription below as they tick.
    const snapshot = metricsBus.getLatestByHost(LOCAL_HOST_ID);
    if (snapshot.length) safeSend(ws, { type: 'snapshot', samples: snapshot });

    // Unwrap the bus envelope: legacy clients on /ws/gpu still expect
    // { type:'sample', samples:[...] } without host_id. host_id is added
    // to the payload so v0.3.1 fleet UI can dispatch per-host without
    // breaking single-host clients that ignore extra fields.
    const onSample = (e: SampleEvent) =>
      safeSend(ws, { type: 'sample', host_id: e.host_id, samples: e.samples });
    const onHostStatus = (e: HostStatusEvent) =>
      safeSend(ws, { type: 'host_status', host_id: e.host_id, status: e.status, last_seen: e.last_seen });
    const onAlert = (event: AlertEvent, rule: AlertRule) =>
      safeSend(ws, { type: 'alert', event, notify_browser: !!rule.notify_browser, notify_sound: !!rule.notify_sound });

    metricsBus.on('sample', onSample);
    metricsBus.on('host_status', onHostStatus);
    alertService.on('event', onAlert);

    ws.on('close', () => {
      metricsBus.off('sample', onSample);
      metricsBus.off('host_status', onHostStatus);
      alertService.off('event', onAlert);
      logger.debug('ws', `client disconnected (user=${payload.username})`);
    });
    ws.on('error', (err) => logger.warn('ws', 'socket error:', err.message));
  });

  logger.success('ws', 'GPU WebSocket ready on /ws/gpu');
  return wss;
}

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn('ws', 'send failed:', (err as Error).message);
  }
}
