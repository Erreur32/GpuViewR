import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDatabase } from '../connection.js';

// Read-only access tokens for /api/v1 and /mcp. The plaintext exists once
// (at creation); only its SHA-256 is stored. A fast hash is right here:
// the token is 256 random bits, so there is nothing to brute-force.

export const API_TOKEN_PREFIX = 'gvk_';
export const MAX_API_TOKENS = 20;
/** last_used_at is rewritten at most this often, not on every request. */
const TOUCH_INTERVAL_S = 60;

export interface ApiTokenRecord {
  id: number;
  name: string;
  /** First characters of the token, to recognise it in the list. */
  prefix: string;
  created_at: number;
  last_used_at: number | null;
}

interface ApiTokenRow extends ApiTokenRecord {
  token_hash: string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
`;

export function ensureApiTokensSchema(db: Database.Database = getDatabase()): void {
  db.exec(DDL);
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const PUBLIC_COLUMNS = 'id, name, prefix, created_at, last_used_at';

export const ApiTokenRepo = {
  list(): ApiTokenRecord[] {
    return getDatabase()
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_tokens ORDER BY created_at DESC, id DESC`)
      .all() as ApiTokenRecord[];
  },

  count(): number {
    return (getDatabase().prepare('SELECT COUNT(*) AS c FROM api_tokens').get() as { c: number }).c;
  },

  /** Creates a token and returns its plaintext, which cannot be read back. */
  create(name: string): { token: string; record: ApiTokenRecord } {
    const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const info = getDatabase()
      .prepare('INSERT INTO api_tokens (name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?)')
      .run(name, hashApiToken(token), token.slice(0, API_TOKEN_PREFIX.length + 4), now);
    const record = getDatabase()
      .prepare(`SELECT ${PUBLIC_COLUMNS} FROM api_tokens WHERE id = ?`)
      .get(info.lastInsertRowid) as ApiTokenRecord;
    return { token, record };
  },

  delete(id: number): boolean {
    return getDatabase().prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes > 0;
  },

  /** The matching token, or null. Bumps last_used_at (throttled). */
  verify(token: string): ApiTokenRecord | null {
    if (!token.startsWith(API_TOKEN_PREFIX)) return null;
    const row = getDatabase()
      .prepare('SELECT * FROM api_tokens WHERE token_hash = ?')
      .get(hashApiToken(token)) as ApiTokenRow | undefined;
    if (!row) return null;
    const now = Math.floor(Date.now() / 1000);
    if (row.last_used_at === null || now - row.last_used_at >= TOUCH_INTERVAL_S) {
      getDatabase().prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id);
      row.last_used_at = now;
    }
    const { token_hash: _omit, ...record } = row;
    return record;
  },
};
