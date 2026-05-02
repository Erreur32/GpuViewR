import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  logger.error('http', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
}
