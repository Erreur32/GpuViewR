import { Router } from 'express';
import { requireApiToken } from '../middleware/apiToken.js';
import {
  currentGpus, fleetGpuStats, fleetLlmProcesses, gpuHistory, gpuStats, healthSummary,
  hostOrLocal, hostProcesses, listHosts,
} from '../services/readOnlyData.js';
import { readVersion } from '../utils/version.js';

// Read-only REST API, /api/v1. GET only, bearer API token (Settings > API).
// Documented in Docs/API.md.

const router = Router();

router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.setHeader('Allow', 'GET, HEAD, OPTIONS');
  res.status(405).json({ error: 'Read-only API: only GET is allowed' });
});
router.use(requireApiToken('api'));
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const ENDPOINTS = [
  'GET /api/v1/health',
  'GET /api/v1/hosts',
  'GET /api/v1/gpus?host=<id>',
  'GET /api/v1/gpus/history?host=<id>&gpu=<index>&range=<1h|24h|7d>',
  'GET /api/v1/gpus/stats?host=<id>&gpu=<index>&range=<24h>',
  'GET /api/v1/gpus/stats/all?range=<24h>',
  'GET /api/v1/processes?host=<id>&gpu=<index>',
  'GET /api/v1/llm',
];

function intParam(raw: unknown, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

router.get('/', (_req, res) => {
  res.json({ name: 'GpuViewR read-only API', version: readVersion(), endpoints: ENDPOINTS });
});

router.get('/health', (_req, res) => {
  res.json(healthSummary(readVersion()));
});

router.get('/hosts', (_req, res) => {
  res.json({ hosts: listHosts() });
});

router.get('/gpus', (req, res) => {
  const host = typeof req.query.host === 'string' && req.query.host.trim() !== '' ? req.query.host.trim() : undefined;
  res.json({ gpus: currentGpus(host) });
});

router.get('/gpus/history', (req, res) => {
  res.json(gpuHistory(hostOrLocal(req.query.host), intParam(req.query.gpu, 0), String(req.query.range ?? '1h')));
});

router.get('/gpus/stats', (req, res) => {
  res.json(gpuStats(hostOrLocal(req.query.host), intParam(req.query.gpu, 0), String(req.query.range ?? '24h')));
});

router.get('/gpus/stats/all', (req, res) => {
  res.json(fleetGpuStats(String(req.query.range ?? '24h')));
});

router.get('/processes', (req, res) => {
  const gpu = req.query.gpu === undefined ? null : intParam(req.query.gpu, 0);
  res.json(hostProcesses(hostOrLocal(req.query.host), gpu));
});

router.get('/llm', (_req, res) => {
  res.json({ processes: fleetLlmProcesses() });
});

export default router;
