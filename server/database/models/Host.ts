// Multi-host registry. Sole consumer for jalon 2: the local install
// seeds a single row with id='local', kind='local'. Jalon 3 adds the
// enrollment path that creates kind='agent' rows with a bcrypt token
// hash. Jalon 5/onwards may add kind='prometheus' for byo-telemetry.
//
// The id is intentionally an opaque string (UUIDv4 for agents,
// the literal 'local' for the hub) so renaming a label or even the
// underlying hostname never breaks historical correlation in
// gpu_metrics / alert_events.

import { getDatabase } from '../connection.js';
import { hostHostname } from '../../utils/hostHostname.js';

/** Hub-side identifier for the local nvidia-smi producer. */
export const LOCAL_HOST_ID = 'local';

export type HostKind = 'local' | 'agent' | 'prometheus';
export type HostStatus = 'pending' | 'online' | 'offline' | 'disabled';

export interface HostRecord {
  id: string;
  label: string;
  hostname: string | null;
  kind: HostKind;
  endpoint: string | null;
  /** bcrypt hash of the enrollment token. NULL for kind='local'. */
  token_hash: string | null;
  /** JSON string of { gpu, system, temps, processes } booleans, or null until first hello. */
  capabilities: string | null;
  agent_version: string | null;
  protocol_ver: number;
  enrolled_at: number;
  last_seen: number | null;
  status: HostStatus;
}

export interface HostInsertInput {
  id: string;
  label: string;
  hostname?: string | null;
  kind: HostKind;
  endpoint?: string | null;
  token_hash?: string | null;
  capabilities?: string | null;
  agent_version?: string | null;
  protocol_ver?: number;
  status?: HostStatus;
}

const DDL = `
CREATE TABLE IF NOT EXISTS hosts (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  hostname      TEXT,
  kind          TEXT NOT NULL,
  endpoint      TEXT,
  token_hash    TEXT,
  capabilities  TEXT,
  agent_version TEXT,
  protocol_ver  INTEGER NOT NULL DEFAULT 1,
  enrolled_at   INTEGER NOT NULL,
  last_seen     INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_hosts_status ON hosts(status);
CREATE INDEX IF NOT EXISTS idx_hosts_kind   ON hosts(kind);
`;

export function ensureHostsSchema(db = getDatabase()): void {
  db.exec(DDL);
}

export const HostsRepo = {
  list(): HostRecord[] {
    return getDatabase()
      .prepare('SELECT * FROM hosts ORDER BY enrolled_at ASC')
      .all() as HostRecord[];
  },

  findById(id: string): HostRecord | undefined {
    return getDatabase()
      .prepare('SELECT * FROM hosts WHERE id = ?')
      .get(id) as HostRecord | undefined;
  },

  findByTokenHash(token_hash: string): HostRecord | undefined {
    return getDatabase()
      .prepare('SELECT * FROM hosts WHERE token_hash = ?')
      .get(token_hash) as HostRecord | undefined;
  },

  insert(input: HostInsertInput): HostRecord {
    const now = Math.floor(Date.now() / 1000);
    getDatabase()
      .prepare(
        `INSERT INTO hosts
         (id, label, hostname, kind, endpoint, token_hash, capabilities,
          agent_version, protocol_ver, enrolled_at, last_seen, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        input.id,
        input.label,
        input.hostname ?? null,
        input.kind,
        input.endpoint ?? null,
        input.token_hash ?? null,
        input.capabilities ?? null,
        input.agent_version ?? null,
        input.protocol_ver ?? 1,
        now,
        input.status ?? 'pending',
      );
    return this.findById(input.id)!;
  },

  update(id: string, patch: Partial<Omit<HostRecord, 'id' | 'enrolled_at'>>): HostRecord | undefined {
    const cur = this.findById(id);
    if (!cur) return undefined;
    const m = { ...cur, ...patch };
    getDatabase()
      .prepare(
        `UPDATE hosts SET
           label = ?, hostname = ?, kind = ?, endpoint = ?, token_hash = ?,
           capabilities = ?, agent_version = ?, protocol_ver = ?,
           last_seen = ?, status = ?
         WHERE id = ?`,
      )
      .run(
        m.label, m.hostname, m.kind, m.endpoint, m.token_hash,
        m.capabilities, m.agent_version, m.protocol_ver,
        m.last_seen, m.status, id,
      );
    return this.findById(id);
  },

  delete(id: string): boolean {
    const r = getDatabase().prepare('DELETE FROM hosts WHERE id = ?').run(id);
    return Number(r.changes || 0) > 0;
  },

  /** Touch `last_seen` to now and flip status to 'online' if it was offline/pending. */
  markSeen(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    getDatabase()
      .prepare(
        `UPDATE hosts
         SET last_seen = ?, status = CASE WHEN status IN ('offline','pending') THEN 'online' ELSE status END
         WHERE id = ?`,
      )
      .run(now, id);
  },

  setStatus(id: string, status: HostStatus): void {
    getDatabase().prepare('UPDATE hosts SET status = ? WHERE id = ?').run(status, id);
  },

  /**
   * Idempotent: insert the 'local' row if missing and (re)refresh
   * its system hostname on every boot so the Hosts table never
   * shows a stale value when the admin renames the box. Called
   * from `runMigrations()` after the table is created.
   *
   * Label policy: defaults to the OS hostname (e.g. "debian-server")
   * — pre-v0.4.0 installs that still carry the legacy 'local' label
   * get a one-shot backfill so the UI stops showing the placeholder.
   * A user-customised label (anything other than 'local') is kept
   * intact so renaming via the Hosts UI sticks across restarts.
   */
  seedLocalIfMissing(db = getDatabase()): void {
    const sysHostname = hostHostname();
    const defaultLabel = sysHostname ?? 'local';
    const existing = db.prepare('SELECT id, label, hostname FROM hosts WHERE id = ?').get(LOCAL_HOST_ID) as
      | { id: string; label: string; hostname: string | null }
      | undefined;
    if (existing) {
      // Refresh hostname unconditionally. Backfill label when it still
      // looks auto-generated, never when it looks user-customised:
      //   - 'local'                  : the legacy literal default.
      //   - == previous hostname     : a previous boot auto-set the label
      //                                from os.hostname() (which inside
      //                                Docker returned the container id
      //                                like '48f38404d5f8'). Now that we
      //                                can read the real host hostname,
      //                                propagate it to the label too.
      //   - looks like a 12-hex docker container id : same case, but for
      //                                installs where label and hostname
      //                                got desynced somehow.
      const looksLikeContainerId = /^[0-9a-f]{12}$/.test(existing.label);
      const wasAutoSet = existing.label === 'local'
        || existing.label === existing.hostname
        || looksLikeContainerId;
      db.prepare('UPDATE hosts SET hostname = ? WHERE id = ?').run(sysHostname, LOCAL_HOST_ID);
      if (wasAutoSet && sysHostname && sysHostname !== existing.label) {
        db.prepare('UPDATE hosts SET label = ? WHERE id = ?').run(sysHostname, LOCAL_HOST_ID);
      }
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO hosts
       (id, label, hostname, kind, endpoint, token_hash, capabilities,
        agent_version, protocol_ver, enrolled_at, last_seen, status)
       VALUES (?, ?, ?, 'local', NULL, NULL, NULL, NULL, 1, ?, NULL, 'online')`,
    ).run(LOCAL_HOST_ID, defaultLabel, sysHostname, now);
  },
};
