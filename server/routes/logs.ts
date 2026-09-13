import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger, type LogLevel } from '../utils/logger.js';

const router = Router();
router.use(requireAuth);

const LEVELS: ReadonlySet<LogLevel | 'all'> = new Set(['all', 'info', 'warn', 'error', 'success', 'debug']);

router.get('/', (req, res) => {
  const level = String(req.query.level || 'all') as LogLevel | 'all';
  if (!LEVELS.has(level)) return res.status(400).json({ error: 'Invalid level' });

  const scope = req.query.scope ? String(req.query.scope) : undefined;
  const search = req.query.q ? String(req.query.q) : undefined;
  const sinceTs = req.query.since ? Number.parseInt(String(req.query.since), 10) : undefined;
  const untilTs = req.query.until ? Number.parseInt(String(req.query.until), 10) : undefined;

  const entries = logger.query({
    level,
    scope,
    search,
    sinceTs,
    untilTs,
    limit: req.query.limit ? Number.parseInt(String(req.query.limit), 10) : 500,
  });
  // counts() intentionally ignores `level` so every filter badge shows its
  // real total (matching scope/search/date) instead of only the count for
  // whichever level is currently selected.
  const counts = logger.counts({ scope, search, sinceTs, untilTs });
  res.json({ entries, scopes: logger.scopes(), counts });
});

export default router;
