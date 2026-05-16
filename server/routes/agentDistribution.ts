// Public, unauthenticated distribution endpoints for the bare-metal
// install path (Beszel-style one-liner). The script + bundle live
// next to /agent/ in the repo so a checked-out hub serves them
// directly without a publish step.
//
// Security: both routes are read-only and gated by a dedicated
// per-IP rate limiter (`installLimiter`). install.sh is a public-by-
// design URL; the actual auth is the agent token issued out-of-band
// via the admin UI, not access to the script.

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPublicUrl } from '../config.js';
import { logger } from '../utils/logger.js';
import { installLimiter } from '../middleware/rateLimit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/routes -> server -> repo root. The agent dir is a sibling.
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENT_DIR = path.join(REPO_ROOT, 'agent');
const TPL_PATH = path.join(AGENT_DIR, 'install.sh.tpl');
const BUNDLE_PATH = path.join(AGENT_DIR, 'dist', 'agent.mjs');
const INSTALL_AGENT_PATH = path.join(REPO_ROOT, 'install-agent.sh');

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

router.get('/install.sh', installLimiter, (req, res) => {
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

router.get('/install-agent.sh', installLimiter, (_req, res) => {
  // Docker variant of /install.sh — auto-detects vendor, pulls the
  // matching docker-compose.agent.<vendor>.yaml from GitHub, generates
  // .env from --hub + --token args, and runs `docker compose up -d`.
  // Served as-is from the repo (no template substitution needed —
  // the script takes --hub and --token explicitly).
  if (!fs.existsSync(INSTALL_AGENT_PATH)) {
    logger.warn('agent-dist', `install-agent.sh missing at ${INSTALL_AGENT_PATH}`);
    res.status(503).type('text/plain').send('# install-agent.sh missing on this hub build\n');
    return;
  }
  res
    .type('text/x-shellscript; charset=utf-8')
    .set('Cache-Control', 'no-store')
    .sendFile(INSTALL_AGENT_PATH);
});

router.get('/agent.mjs', installLimiter, (_req, res) => {
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
