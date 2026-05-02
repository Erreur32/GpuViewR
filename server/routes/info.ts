import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
// __dirname is server/routes/, repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

// Whitelist: only these filenames may be served, resolved against the
// repo root. Avoids any user-controlled path traversal even though the
// caller never names a file directly.
const FILES = {
  changelog: path.join(REPO_ROOT, 'CHANGELOG.md'),
  readme: path.join(REPO_ROOT, 'README.md'),
} as const;

function readSafe(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    if (stat.size > 1_000_000) return null; // hard cap, ~1 MB
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

router.get('/changelog', (_req, res) => {
  const content = readSafe(FILES.changelog);
  if (content === null) return res.status(404).json({ error: 'CHANGELOG.md not found' });
  res.json({ content });
});

router.get('/readme', (_req, res) => {
  const content = readSafe(FILES.readme);
  if (content === null) return res.status(404).json({ error: 'README.md not found' });
  res.json({ content });
});

export default router;
