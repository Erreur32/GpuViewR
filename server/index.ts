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
import { apiLimiter, authLimiter, metricsLimiter } from './middleware/rateLimit.js';
import { gpuCollector, startRetentionJob } from './services/gpuCollector.js';
import { setupGpuWebSocket } from './services/gpuStreamWS.js';
import { alertService } from './services/alertService.js';
import { updateService } from './services/updateService.js';
import { exportService } from './services/exportService.js';
import { ensurePortFreeOrExit, getDisplayIP, renderBanner } from './utils/banner.js';

import authRoutes from './routes/auth.js';
import gpuRoutes from './routes/gpu.js';
import healthRoutes from './routes/health.js';
import alertsRoutes from './routes/alerts.js';
import logsRoutes from './routes/logs.js';
import updatesRoutes from './routes/updates.js';
import systemRoutes from './routes/system.js';
import exportsRoutes from './routes/exports.js';
import metricsRoutes from './routes/metrics.js';

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
  exportService.init();

  const app = express();
  app.disable('x-powered-by');
  // Trust the first proxy hop (typical reverse-proxy setup) so that
  // express-rate-limit and req.ip use X-Forwarded-For correctly.
  app.set('trust proxy', 1);
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  app.use('/api', apiLimiter);
  app.use('/api/health', healthRoutes);
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/gpu', gpuRoutes);
  app.use('/api/alerts', alertsRoutes);
  app.use('/api/logs', logsRoutes);
  app.use('/api/updates', updatesRoutes);
  app.use('/api/system', systemRoutes);
  app.use('/api/exports', exportsRoutes);
  app.use('/metrics', metricsLimiter, metricsRoutes);

  const distDir = path.resolve(__dirname, '..', 'dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/|\/ws\/|\/metrics(?:$|\/)).*/, (_req, res) => {
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
    exportService.shutdown();
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

  // In Docker, DASHBOARD_PORT is the host port mapped to the container's PORT.
  // The banner must show that *external* port to be openable from a browser
  // (the container-internal port: config.port: would be unreachable from the host).
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || String(config.port), 10);

  // In dev, the user opens Vite (5181 by default); in Docker prod, Express serves dist/ directly.
  const vitePort = parseInt(process.env.VITE_PORT || '5181', 10);

  let frontendWeb: string;
  let frontendLocal: string;
  let backendApi: string;
  let wsUrl: string;

  if (publicUrl && isProd) {
    // Reverse-proxy / public domain configured: use it for everything.
    frontendWeb = publicUrl;
    frontendLocal = publicUrl;
    backendApi = publicUrl;
    wsUrl = publicUrl.replace(/^http/, 'ws') + '/ws/gpu';
  } else if (isDocker) {
    // Docker: external URL uses host IP + DASHBOARD_PORT; localhost line uses
    // the same external port (the container-internal port is hidden from users).
    frontendWeb = `http://${ip}:${dashboardPort}`;
    frontendLocal = `http://localhost:${dashboardPort}`;
    backendApi = frontendWeb;
    wsUrl = frontendWeb.replace(/^http/, 'ws') + '/ws/gpu';
  } else if (isProd) {
    // Bare-metal `npm start`: Express serves the bundle directly on PORT.
    frontendWeb = `http://${ip}:${config.port}`;
    frontendLocal = `http://localhost:${config.port}`;
    backendApi = frontendWeb;
    wsUrl = frontendWeb.replace(/^http/, 'ws') + '/ws/gpu';
  } else {
    // npm run dev: Vite on VITE_PORT, backend on config.port, both on the dev box.
    frontendWeb = `http://${ip}:${vitePort}`;
    frontendLocal = `http://localhost:${vitePort}`;
    backendApi = `http://${ip}:${config.port}`;
    wsUrl = backendApi.replace(/^http/, 'ws') + '/ws/gpu';
  }

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
    backendApi,
    websocket: wsUrl,
    features: [
      'Authentication (JWT + bcryptjs)',
      'Live GPU streaming (WebSocket)',
      'Multi-GPU + 5 themes + arc/bar gauges',
      'Alerts engine (sustain + cooldown)',
      'Filterable server logs',
    ],
  });

  // eslint-disable-next-line no-console
  console.log(banner);

  // Compact summary into the persistent log buffer (visible in /logs page).
  logger.success('boot', `Listening on ${backendApi} (env: ${envLabel}, ip: ${ip})`);
  logger.info('boot', `Frontend WEB:   ${frontendWeb}`);
  logger.info('boot', `Frontend Local: ${frontendLocal}`);
  logger.info('boot', `Backend  API:   ${backendApi}/api/health`);
  logger.info('boot', `WebSocket:      ${wsUrl}`);
}

void bootstrap();
