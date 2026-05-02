import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger, type LogLevel } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

const LEVELS: ReadonlyArray<LogLevel | 'all'> = ['all', 'info', 'warn', 'error', 'success', 'debug'];

router.get('/', (req, res) => {
  const level = String(req.query.level || 'all') as LogLevel | 'all';
  if (!LEVELS.includes(level)) return res.status(400).json({ error: 'Invalid level' });

  const entries = logger.query({
    level,
    scope: req.query.scope ? String(req.query.scope) : undefined,
    search: req.query.q ? String(req.query.q) : undefined,
    sinceTs: req.query.since ? parseInt(String(req.query.since), 10) : undefined,
    untilTs: req.query.until ? parseInt(String(req.query.until), 10) : undefined,
    limit: req.query.limit ? parseInt(String(req.query.limit), 10) : 500,
  });
  res.json({ entries, scopes: logger.scopes() });
});

export default router;
