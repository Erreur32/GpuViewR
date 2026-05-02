import { getDatabase } from '../connection.js';

export interface AppConfigRow {
  key: string;
  value: string;
}

const ddl = `
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function ensureAppConfigSchema(): void {
  getDatabase().exec(ddl);
}

export const AppConfigRepo = {
  get(key: string): string | null {
    const row = getDatabase().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as AppConfigRow | undefined;
    return row?.value ?? null;
  },
  getJson<T>(key: string): T | null {
    const v = this.get(key);
    if (!v) return null;
    try { return JSON.parse(v) as T; } catch { return null; }
  },
  set(key: string, value: string): void {
    getDatabase()
      .prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  },
  setJson<T>(key: string, value: T): void {
    this.set(key, JSON.stringify(value));
  },
};
