import { getDatabase } from '../connection.js';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: 'admin' | 'user';
  created_at: number;
  token_version: number;
}

export const UserRepository = {
  findAll(): User[] {
    return getDatabase().prepare('SELECT * FROM users ORDER BY id ASC').all() as User[];
  },

  findByUsername(username: string): User | undefined {
    return getDatabase()
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as User | undefined;
  },

  findById(id: number): User | undefined {
    return getDatabase()
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as User | undefined;
  },

  count(): number {
    const row = getDatabase().prepare('SELECT COUNT(*) as c FROM users').get() as { c: number };
    return row.c;
  },

  create(username: string, passwordHash: string, role: 'admin' | 'user' = 'user'): User {
    const stmt = getDatabase().prepare(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
    );
    const info = stmt.run(username, passwordHash, role, Math.floor(Date.now() / 1000));
    return this.findById(Number(info.lastInsertRowid))!;
  },

  /** Also bumps token_version, which revokes every token signed before. */
  updatePassword(id: number, passwordHash: string): void {
    getDatabase()
      .prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
      .run(passwordHash, id);
  },

  updateUsername(id: number, username: string): void {
    getDatabase().prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
  },

  delete(id: number): void {
    getDatabase().prepare('DELETE FROM users WHERE id = ?').run(id);
  },
};
