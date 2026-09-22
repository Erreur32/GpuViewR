import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { authService } from '../services/authService.js';
import { UserRepository } from '../database/models/User.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

router.get('/status', (_req, res) => {
  const userCount = UserRepository.count();
  res.json({ hasUsers: userCount > 0, userCount });
});

router.post('/register', authLimiter, async (req, res) => {
  try {
    // Open registration is only for the very first (bootstrap) admin
    // account. Once any user exists, only an already-authenticated
    // admin may create further accounts — otherwise anyone reaching
    // the hub over the network could self-register a `user`-role
    // account with no invite, no approval, nothing.
    if (UserRepository.count() > 0 && !isCallerAdmin(req)) {
      return res.status(403).json({ error: 'Registration is closed. Ask an admin to create your account.' });
    }
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password required' });
    }
    const { user, token } = await authService.register(username, password);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** True when the request carries a valid admin JWT. Same Bearer-token
 *  parsing as requireAuth (middleware/auth.js), duplicated as a plain
 *  boolean check here because /register must stay reachable
 *  unauthenticated for the bootstrap (zero-user) case — it can't sit
 *  behind requireAuth/requireAdmin as route-level middleware. */
function isCallerAdmin(req: Request): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const payload = authService.verifyToken(header.slice('Bearer '.length));
  return payload?.role === 'admin';
}

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password required' });
    }
    const { user, token } = await authService.login(username, password);
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
