import { Router } from 'express';
import { gpuCollector } from '../services/gpuCollector.js';

const router = Router();

router.get('/', (_req, res) => {
  const samples = gpuCollector.getLatest();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    gpuCount: samples.length,
    timestamp: new Date().toISOString(),
  });
});

export default router;
