import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { config, getPublicUrl } from './config.js';
import { initializeDatabase, closeDatabase } from './database/connection.js';
import { logger } from './utils/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { gpuCollector, startRetentionJob } from './services/gpuCollector.js';
import { setupGpuWebSocket } from './services/gpuStreamWS.js';
import { alertService } from './services/alertService.js';
import { updateService } from './services/updateService.js';
import { ensurePortFreeOrExit, getDisplayIP, renderBanner } from './utils/banner.js';

import authRoutes from './routes/auth.js';
import gpuRoutes from './routes/gpu.js';
import healthRoutes from './routes/health.js';
import alertsRoutes from './routes/alerts.js';
import logsRoutes from './routes/logs.js';
import updatesRoutes from './routes/updates.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function bootstrap(): Promise<void> {
  await ensurePortFreeOrExit(config.port, 'backend');

  initializeDatabase();
  alertService.init();
  updateService.init();

  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/gpu', gpuRoutes);
  app.use('/api/alerts', alertsRoutes);
  app.use('/api/logs', logsRoutes);
  app.use('/api/updates', updatesRoutes);

  const distDir = path.resolve(__dirname, '..', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/|\/ws\/).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else if (config.nodeEnv === 'production') {
    logger.warn('boot', `dist/ not found at ${distDir}`);
  }

  app.use(errorHandler);

  const server = http.createServer(app);
  setupGpuWebSocket(server);

  gpuCollector.start();
  startRetentionJob();

  server.listen(config.port, '0.0.0.0', () => {
    printBoot();
  });

  const shutdown = (signal: string) => {
    logger.info('boot', `Received ${signal}, shutting down...`);
    gpuCollector.stop();
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function printBoot(): void {
  const version = readVersion();
  const isProd = config.nodeEnv === 'production';
  const isDocker = !!process.env.CONTAINER_NAME || fs.existsSync('/.dockerenv');

  const containerName = process.env.CONTAINER_NAME
    || (isDocker ? (os.hostname() || 'gpuviewr') : 'NPM DEV');

  const ip = getDisplayIP();
  const publicUrl = getPublicUrl();

  // In dev, the user opens Vite (5181 by default); in Docker prod, Express serves dist/ directly.
  const vitePort = parseInt(process.env.VITE_PORT || '5181', 10);
  const backendUrl = publicUrl && isProd ? publicUrl : `http://${ip}:${config.port}`;
  const localBackend = `http://localhost:${config.port}`;
  const frontendWeb = isProd
    ? backendUrl
    : `http://${ip}:${vitePort}`;
  const frontendLocal = isProd
    ? localBackend
    : `http://localhost:${vitePort}`;

  const wsUrl = (isProd ? backendUrl : `http://${ip}:${config.port}`).replace(/^http/, 'ws') + '/ws/gpu';

  let envLabel: string;
  if (isProd && isDocker) envLabel = `Docker · v${version}`;
  else if (isDocker) envLabel = `Docker DEV · v${version}`;
  else if (isProd) envLabel = `Production · v${version}`;
  else envLabel = `NPM DEV · v${version}`;

  const banner = renderBanner({
    title: 'GpuViewR',
    subtitle: 'Real-time NVIDIA GPU Dashboard',
    version,
    envLabel,
    containerName,
    frontendWeb,
    frontendLocal,
    backendApi: backendUrl,
    websocket: wsUrl,
    features: [
      'Authentication (JWT + bcrypt)',
      'Live GPU streaming (WebSocket)',
      'Multi-GPU + 5 themes + arc/bar gauges',
      'Alerts engine (sustain + cooldown)',
      'Filterable server logs',
    ],
  });

  // eslint-disable-next-line no-console
  console.log(banner);

  // Compact summary into the persistent log buffer (visible in /logs page).
  logger.success('boot', `Listening on ${backendUrl} (env: ${envLabel}, ip: ${ip})`);
  logger.info('boot', `Frontend WEB:   ${frontendWeb}`);
  logger.info('boot', `Frontend Local: ${frontendLocal}`);
  logger.info('boot', `Backend  API:   ${backendUrl}/api/health`);
  logger.info('boot', `WebSocket:      ${wsUrl}`);
}

void bootstrap();
