import type { Request, Response, NextFunction } from 'express';
import { ApiTokenRepo, type ApiTokenRecord } from '../database/models/ApiToken.js';
import { accessSettings, type AccessSurface } from '../services/accessSettings.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiToken?: ApiTokenRecord;
    }
  }
}

/** Gate for the read-only surfaces: switched on in Settings, then a valid
 *  `Authorization: Bearer gvk_...` token. */
export function requireApiToken(surface: AccessSurface) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!accessSettings.isEnabled(surface)) {
      return res.status(403).json({ error: `${surface.toUpperCase()} access is disabled (Settings > ${surface.toUpperCase()})` });
    }
    const header = req.headers.authorization;
    const record = header?.startsWith('Bearer ') ? ApiTokenRepo.verify(header.slice('Bearer '.length)) : null;
    if (!record) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Missing or invalid API token' });
    }
    req.apiToken = record;
    next();
  };
}
