import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { authService } from './authService.js';
import { gpuCollector } from './gpuCollector.js';
import { metricsBus, type SampleEvent } from './_metricsBus.js';
import { alertService } from './alertService.js';
import { logger } from '../utils/logger.js';
import type { AlertEvent, AlertRule } from '../database/models/Alert.js';

export function setupGpuWebSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: '/ws/gpu' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const payload = authService.verifyToken(token);
    if (!payload) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    logger.debug('ws', `client connected (user=${payload.username})`);

    const snapshot = gpuCollector.getLatest();
    if (snapshot.length) safeSend(ws, { type: 'snapshot', samples: snapshot });

    // Unwrap the bus envelope: legacy clients on /ws/gpu still expect
    // { type:'sample', samples:[...] } without host_id. Multi-host clients
    // (v0.3.1) will get a richer payload via a new code path.
    const onSample = (e: SampleEvent) => safeSend(ws, { type: 'sample', samples: e.samples });
    const onAlert = (event: AlertEvent, rule: AlertRule) =>
      safeSend(ws, { type: 'alert', event, notify_browser: !!rule.notify_browser, notify_sound: !!rule.notify_sound });

    metricsBus.on('sample', onSample);
    alertService.on('event', onAlert);

    ws.on('close', () => {
      metricsBus.off('sample', onSample);
      alertService.off('event', onAlert);
      logger.debug('ws', `client disconnected (user=${payload.username})`);
    });
    ws.on('error', (err) => logger.warn('ws', 'socket error:', err.message));
  });

  logger.success('ws', 'GPU WebSocket ready on /ws/gpu');
}

function safeSend(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    logger.warn('ws', 'send failed:', (err as Error).message);
  }
}
