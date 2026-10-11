import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { ApiTokenRepo, MAX_API_TOKENS } from '../database/models/ApiToken.js';
import { accessSettings } from '../services/accessSettings.js';
import { MCP_TOOLS } from '../services/mcpServer.js';
import { logger } from '../utils/logger.js';

// Settings > API and Settings > MCP: on/off switches and the read-only
// tokens both surfaces accept. Admin only; the tokens themselves can only
// read (see routes/publicApi.ts and routes/mcp.ts).

const router = Router();
router.use(requireAuth, requireAdmin);

const NAME_MAX = 64;

router.get('/', (_req, res) => {
  res.json({
    api_enabled: accessSettings.isEnabled('api'),
    mcp_enabled: accessSettings.isEnabled('mcp'),
    tokens: ApiTokenRepo.list(),
    max_tokens: MAX_API_TOKENS,
    mcp_tools: MCP_TOOLS,
  });
});

router.put('/', (req, res) => {
  const { api_enabled, mcp_enabled } = (req.body ?? {}) as { api_enabled?: unknown; mcp_enabled?: unknown };
  for (const [surface, value] of [['api', api_enabled], ['mcp', mcp_enabled]] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return res.status(400).json({ error: `${surface}_enabled must be a boolean` });
    accessSettings.setEnabled(surface, value);
    logger.info('access', `${surface.toUpperCase()} access ${value ? 'enabled' : 'disabled'} by ${req.user?.username}`);
  }
  res.json({ api_enabled: accessSettings.isEnabled('api'), mcp_enabled: accessSettings.isEnabled('mcp') });
});

router.post('/tokens', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  // No control characters: the name is written to the hub log.
  if (name === '' || name.length > NAME_MAX || /\p{Cc}/u.test(name)) {
    return res.status(400).json({ error: `name is required (max ${NAME_MAX} characters, no control characters)` });
  }
  if (ApiTokenRepo.count() >= MAX_API_TOKENS) {
    return res.status(400).json({ error: `Token limit reached (${MAX_API_TOKENS})` });
  }
  const { token, record } = ApiTokenRepo.create(name);
  logger.info('access', `API token "${name}" created by ${req.user?.username}`);
  // The only time the plaintext leaves the hub: keep it out of caches.
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ token, record });
});

router.delete('/tokens/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || !ApiTokenRepo.delete(id)) return res.status(404).json({ error: 'Token not found' });
  logger.info('access', `API token #${id} revoked by ${req.user?.username}`);
  res.json({ ok: true });
});

export default router;
