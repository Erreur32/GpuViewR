// Multi-host registry API. All endpoints require auth; mutating ones
// also require admin. The enrollment endpoint is the only place the
// plaintext token ever exists — it's returned ONCE, then only the
// bcrypt hash is on disk and no further read can recover it.

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { HostsRepo, LOCAL_HOST_ID, type HostRecord, type HostStatus } from '../database/models/Host.js';

const SALT_ROUNDS = 10;
const TOKEN_PREFIX = 'gpvr_';
const LABEL_MAX = 64;

function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

type PublicHost = Omit<HostRecord, 'token_hash'>;

function stripSensitive(h: HostRecord): PublicHost {
  const { token_hash: _omit, ...rest } = h;
  return rest;
}

const router = Router();

router.use(requireAuth);

// -------- Read endpoints (any authenticated user) --------

router.get('/', (_req, res) => {
  res.json({ hosts: HostsRepo.list().map(stripSensitive) });
});

router.get('/:id', (req, res) => {
  const host = HostsRepo.findById(req.params.id);
  if (!host) return res.status(404).json({ error: 'Not found' });
  res.json({ host: stripSensitive(host) });
});

router.get('/:id/status', (req, res) => {
  const host = HostsRepo.findById(req.params.id);
  if (!host) return res.status(404).json({ error: 'Not found' });
  const now = Math.floor(Date.now() / 1000);
  res.json({
    id: host.id,
    status: host.status,
    last_seen: host.last_seen,
    lag_seconds: host.last_seen ? Math.max(0, now - host.last_seen) : null,
  });
});

// -------- Mutating endpoints (admin only) --------

router.use(requireAdmin);

router.post('/', (req, res) => {
  void handleEnroll(req, res);
});

async function handleEnroll(req: Request, res: Response): Promise<void> {
  const labelRaw = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  if (labelRaw.length === 0 || labelRaw.length > LABEL_MAX) {
    res.status(400).json({ error: `label required (1-${LABEL_MAX} chars)` });
    return;
  }
  const id = randomUUID();
  const token = generateToken();
  const token_hash = await bcrypt.hash(token, SALT_ROUNDS);
  const host = HostsRepo.insert({
    id,
    label: labelRaw,
    kind: 'agent',
    token_hash,
    status: 'pending',
  });
  res.status(201).json({
    host: stripSensitive(host),
    token, // shown once — caller MUST copy now
  });
}

router.patch('/:id', (req, res) => {
  if (req.params.id === LOCAL_HOST_ID) {
    return res.status(400).json({ error: 'cannot modify local host' });
  }
  const patch: Partial<Omit<HostRecord, 'id' | 'enrolled_at'>> = {};
  if (typeof req.body?.label === 'string') {
    const l = req.body.label.trim();
    if (l.length === 0 || l.length > LABEL_MAX) {
      return res.status(400).json({ error: `label (1-${LABEL_MAX} chars)` });
    }
    patch.label = l;
  }
  if (typeof req.body?.status === 'string') {
    const allowed: HostStatus[] = ['pending', 'online', 'offline', 'disabled'];
    if (!allowed.includes(req.body.status as HostStatus)) {
      return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
    }
    patch.status = req.body.status as HostStatus;
  }
  const updated = HostsRepo.update(req.params.id, patch);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json({ host: stripSensitive(updated) });
});

router.post('/:id/rotate-token', (req, res) => {
  void handleRotate(req, res);
});

async function handleRotate(req: Request, res: Response): Promise<void> {
  // Cast to string: express's untyped Request<> generic widens req.params
  // to string|string[] when used outside an inline router handler. Same
  // workaround as in routes/alerts.ts handlers.
  const idParam = req.params.id as string;
  if (idParam === LOCAL_HOST_ID) {
    res.status(400).json({ error: 'local host has no token' });
    return;
  }
  const cur = HostsRepo.findById(idParam);
  if (!cur) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (cur.kind !== 'agent') {
    res.status(400).json({ error: 'not an agent host' });
    return;
  }
  const token = generateToken();
  const token_hash = await bcrypt.hash(token, SALT_ROUNDS);
  HostsRepo.update(cur.id, { token_hash });
  res.json({ token });
}

router.delete('/:id', (req, res) => {
  if (req.params.id === LOCAL_HOST_ID) {
    return res.status(400).json({ error: 'cannot delete local host' });
  }
  const ok = HostsRepo.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  // Note: associated gpu_metrics / gpu_devices / alert_events rows are
  // kept by design for forensic / audit reasons. Jalon 5 will add an
  // optional ?purge_metrics=1 flag.
  res.status(204).end();
});

export default router;
