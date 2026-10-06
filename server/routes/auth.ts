import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { authService, canRegister, AccountChangeError, REGISTRATION_CLOSED_MESSAGE } from '../services/authService.js';
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
    if (!canRegister(UserRepository.count(), callerIsAdmin)) {
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

// Change the caller's own password. Rate-limited like login: the current
// password check is a guessing oracle for a stolen session token.
router.post('/password', authLimiter, requireAuth, async (req, res) => {
  const { current_password: current, new_password: next } = req.body || {};
  if (typeof current !== 'string' || typeof next !== 'string') {
    return res.status(400).json({ error: 'current_password and new_password required' });
  }
  try {
    const token = await authService.changePassword(req.user!.sub, current, next);
    res.json({ ok: true, token });
  } catch (err) {
    if (err instanceof AccountChangeError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Password change failed' });
  }
});

// Rename the caller's own account. Same gate and rate limit as /password.
router.post('/username', authLimiter, requireAuth, async (req, res) => {
  const { current_password: current, new_username: next } = req.body || {};
  if (typeof current !== 'string' || typeof next !== 'string') {
    return res.status(400).json({ error: 'current_password and new_username required' });
  }
  try {
    const { user, token } = await authService.changeUsername(req.user!.sub, current, next);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    if (err instanceof AccountChangeError) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Username change failed' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
