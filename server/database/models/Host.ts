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
/** How the agent runs on the remote: 'docker' compose stack vs
 *  'systemd' (bare-metal). Drives which update command the UI shows
 *  per host — picking the wrong one creates a "double agent" install.
 *  'unknown' = pre-v0.5.3 agent or a developer running `node` by hand. */
export type InstallMode = 'docker' | 'systemd' | 'unknown';

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
  install_mode: InstallMode | null;
  /** 0/1 (SQLite has no real bool). When 1 and the agent's reported
   *  version < hub version AND install_mode='systemd', the hub pushes
   *  the latest agent.mjs over the WS at hello time. Default 0 (opt-in)
   *  because auto-update gives the hub binary-execution authority on
   *  the remote — admins must consciously trust this hub before
   *  flipping it on. */
  auto_update: number;
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
  install_mode?: InstallMode | null;
  auto_update?: number;
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
  install_mode  TEXT,
  auto_update   INTEGER NOT NULL DEFAULT 0,
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
          agent_version, install_mode, auto_update, protocol_ver, enrolled_at, last_seen, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
        input.install_mode ?? null,
        input.auto_update ?? 0,
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
           capabilities = ?, agent_version = ?, install_mode = ?, auto_update = ?,
           protocol_ver = ?, last_seen = ?, status = ?
         WHERE id = ?`,
      )
      .run(
        m.label, m.hostname, m.kind, m.endpoint, m.token_hash,
        m.capabilities, m.agent_version, m.install_mode, m.auto_update,
        m.protocol_ver, m.last_seen, m.status, id,
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
   * v0.5 boot maintenance for the local host row.
   *
   * - Refreshes hostname + auto-set labels (Docker container id, legacy
   *   'local', or label equal to old hostname) on every boot.
   * - Migrates a legacy kind='local' row (v0.4.x) to kind='agent'. The
   *   sidecar agent in v0.5+ is just another agent on the wire, so the
   *   kind column needs to reflect that for the watchdog + UI to treat
   *   it consistently. Token_hash stays NULL — sidecar auth goes
   *   through the bootstrap shared-secret path, not bcrypt.
   * - No INSERT here anymore: the row is auto-created on the sidecar's
   *   first handshake via upsertLocalSidecarHost in agentIngestWS.ts.
   *   In aggregator-only mode (no sidecar), no row exists for 'local'
   *   and that's correct.
   *
   * Called from runMigrations() after the table is created.
   */
  seedLocalIfMissing(db = getDatabase()): void {
    const sysHostname = hostHostname();
    const existing = db.prepare('SELECT id, label, hostname, kind FROM hosts WHERE id = ?').get(LOCAL_HOST_ID) as
      | { id: string; label: string; hostname: string | null; kind: string }
      | undefined;
    if (!existing) return;
    // 1. Hostname refresh + label backfill (mirrors v0.4 behaviour)
    const looksLikeContainerId = /^[0-9a-f]{12}$/.test(existing.label);
    const wasAutoSet = existing.label === 'local'
      || existing.label === existing.hostname
      || looksLikeContainerId;
    db.prepare('UPDATE hosts SET hostname = ? WHERE id = ?').run(sysHostname, LOCAL_HOST_ID);
    if (wasAutoSet && sysHostname && sysHostname !== existing.label) {
      db.prepare('UPDATE hosts SET label = ? WHERE id = ?').run(sysHostname, LOCAL_HOST_ID);
    }
    // 2. v0.4 → v0.5 kind migration. Token_hash stays as-is (NULL on
    // legacy rows; shared-secret auth doesn't need it).
    if (existing.kind !== 'agent') {
      db.prepare("UPDATE hosts SET kind = 'agent' WHERE id = ?").run(LOCAL_HOST_ID);
    }
  },
};
