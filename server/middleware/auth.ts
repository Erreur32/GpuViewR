import type { Request, Response, NextFunction } from 'express';
import { authService, type JwtPayload } from '../services/authService.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/** Extracts and verifies the Bearer JWT from a request, or null if
 *  absent/invalid/expired. Shared by requireAuth below and any route
 *  that needs to check auth optionally (e.g. /api/auth/register,
 *  which must stay reachable unauthenticated for the bootstrap case
 *  and so can't sit behind requireAuth as route-level middleware). */
export function getBearerPayload(req: Request): JwtPayload | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return authService.verifyToken(header.slice('Bearer '.length));
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const payload = getBearerPayload(req);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = payload;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}
