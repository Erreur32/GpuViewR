// Public, unauthenticated distribution endpoints for the bare-metal
// install path (Beszel-style one-liner). The script + bundle live
// next to /agent/ in the repo so a checked-out hub serves them
// directly without a publish step.
//
// Security: both routes are read-only and rate-limited by the
// `/api` limiter mounted in index.ts (we re-apply via the route
// being mounted at root). install.sh is a public-by-design URL;
// the actual auth is the agent token, not access to the script.

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicUrl } from '../config.js';
import { logger } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/routes -> server -> repo root. The agent dir is a sibling.
const AGENT_DIR = path.resolve(__dirname, '..', '..', 'agent');
const TPL_PATH = path.join(AGENT_DIR, 'install.sh.tpl');
const BUNDLE_PATH = path.join(AGENT_DIR, 'dist', 'agent.mjs');

// One-shot boot warning when the bundle is missing — surfaces the
// install.sh path being broken before any user tries to enroll.
if (!fs.existsSync(BUNDLE_PATH)) {
  logger.warn(
    'agent-dist',
    `agent.mjs missing at ${BUNDLE_PATH}; /install.sh + /agent.mjs will 503. ` +
    `Build the bundle once with: npm run build:agent`,
  );
}

const router = Router();

function resolveHubUrl(req: { protocol: string; get: (h: string) => string | undefined }): string {
  const publicUrl = getPublicUrl();
  if (publicUrl) return publicUrl.replace(/\/$/, '');
  const host = req.get('host') ?? 'localhost';
  return `${req.protocol}://${host}`;
}

router.get('/install.sh', (req, res) => {
  if (!fs.existsSync(TPL_PATH)) {
    logger.warn('agent-dist', `install.sh template missing at ${TPL_PATH}`);
    res.status(503).type('text/plain').send('# install.sh template not found in this build\n');
    return;
  }
  const tpl = fs.readFileSync(TPL_PATH, 'utf8');
  const hubUrl = resolveHubUrl(req);
  const body = tpl.replaceAll('__HUB_URL__', hubUrl);
  res
    .type('text/x-shellscript; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .send(body);
});

router.get('/agent.mjs', (_req, res) => {
  if (!fs.existsSync(BUNDLE_PATH)) {
    logger.warn('agent-dist', `agent.mjs missing at ${BUNDLE_PATH} (run: npm run build --prefix agent)`);
    res.status(503).type('application/javascript').send(
      '// gpuviewr agent bundle missing on this hub.\n' +
      '// Hub maintainer: run `npm run build --prefix agent` and restart.\n',
    );
    return;
  }
  // Public but stable — the bundle changes on every hub upgrade so a
  // short cache window is safe and saves bandwidth when an agent
  // reinstalls from a script.
  res
    .type('application/javascript; charset=utf-8')
    .set('Cache-Control', 'public, max-age=300')
    .sendFile(BUNDLE_PATH);
});

export default router;
