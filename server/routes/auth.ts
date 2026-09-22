import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { authService, REGISTRATION_CLOSED_MESSAGE } from '../services/authService.js';
import { UserRepository } from '../database/models/User.js';
import { requireAuth, getBearerPayload } from '../middleware/auth.js';

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
    // account with no invite, no approval, nothing. Cheap short-circuit
    // here for the (overwhelmingly common) already-closed case; the
    // authoritative, race-safe re-check happens inside
    // authService.register's serialized section (see its comment) —
    // two concurrent bootstrap requests can both reach this point with
    // count()===0, so this alone isn't sufficient.
    const callerIsAdmin = isCallerAdmin(req);
    if (UserRepository.count() > 0 && !callerIsAdmin) {
      return res.status(403).json({ error: REGISTRATION_CLOSED_MESSAGE });
    }
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password required' });
    }
    const { user, token } = await authService.register(username, password, { callerIsAdmin });
    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** True when the request carries a valid admin JWT. Uses the same
 *  extraction as requireAuth (getBearerPayload) but as a plain boolean
 *  check, because /register must stay reachable unauthenticated for
 *  the bootstrap (zero-user) case — it can't sit behind
 *  requireAuth/requireAdmin as route-level middleware. */
function isCallerAdmin(req: Request): boolean {
  return getBearerPayload(req)?.role === 'admin';
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
