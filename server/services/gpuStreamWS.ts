import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { authService } from './authService.js';
import { gpuCollector, type GpuSample } from './gpuCollector.js';
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

    logger.info('ws', `client connected (user=${payload.username})`);

    const snapshot = gpuCollector.getLatest();
    if (snapshot.length) safeSend(ws, { type: 'snapshot', samples: snapshot });

    const onSample = (samples: GpuSample[]) => safeSend(ws, { type: 'sample', samples });
    const onAlert = (event: AlertEvent, rule: AlertRule) =>
      safeSend(ws, { type: 'alert', event, notify_browser: !!rule.notify_browser, notify_sound: !!rule.notify_sound });

    gpuCollector.on('sample', onSample);
    alertService.on('event', onAlert);

    ws.on('close', () => {
      gpuCollector.off('sample', onSample);
      alertService.off('event', onAlert);
      logger.info('ws', `client disconnected (user=${payload.username})`);
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
