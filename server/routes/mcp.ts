import { Router, type Request } from 'express';
import { requireApiToken } from '../middleware/apiToken.js';
import { handleMcpMessage } from '../services/mcpServer.js';

// MCP endpoint (Streamable HTTP, POST only). Every tool is read-only.
// Bearer API token, switched on in Settings > MCP.

const router = Router();

/** A browser page on another origin must not drive the endpoint (DNS
 *  rebinding, MCP transport spec). Non-browser clients send no Origin. */
function foreignOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

router.use((req, res, next) => {
  if (foreignOrigin(req)) return res.status(403).json({ error: 'Origin not allowed' });
  next();
});
router.use(requireApiToken('mcp'));

router.post('/', (req, res) => {
  const body: unknown = req.body;
  if (Array.isArray(body)) {
    const replies = body.map(handleMcpMessage).filter((r) => r !== null);
    if (replies.length === 0) return res.status(202).end();
    return res.json(replies);
  }
  const reply = handleMcpMessage(body);
  if (reply === null) return res.status(202).end();
  res.json(reply);
});

router.all('/', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'MCP endpoint: POST only' });
});

export default router;
