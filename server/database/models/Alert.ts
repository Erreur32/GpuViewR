import { getDatabase } from '../connection.js';

export type AlertMetric = 'temperature' | 'utilization' | 'memory' | 'power' | 'fan_speed';
export type AlertCondition = 'above' | 'below';

export interface AlertRule {
  id: number;
  name: string;
  metric: AlertMetric;
  condition: AlertCondition;
  threshold: number;
  /** Sustain duration in seconds: value must stay above/below threshold for this long */
  duration_s: number;
  gpu_index: number | null; // null = all GPUs
  enabled: 0 | 1;
  notify_browser: 0 | 1;
  notify_sound: 0 | 1;
  cooldown_s: number;
  created_at: number;
}

export interface AlertEvent {
  id: number;
  rule_id: number;
  rule_name: string;
  gpu_index: number;
  metric: AlertMetric;
  threshold: number;
  observed: number;
  state: 'firing' | 'resolved';
  triggered_at: number;
  message: string;
}

const ddl = `
CREATE TABLE IF NOT EXISTS alert_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  metric TEXT NOT NULL,
  condition TEXT NOT NULL,
  threshold REAL NOT NULL,
  duration_s INTEGER NOT NULL DEFAULT 0,
  gpu_index INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  notify_browser INTEGER NOT NULL DEFAULT 1,
  notify_sound INTEGER NOT NULL DEFAULT 0,
  cooldown_s INTEGER NOT NULL DEFAULT 300,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id INTEGER NOT NULL,
  rule_name TEXT NOT NULL,
  gpu_index INTEGER NOT NULL,
  metric TEXT NOT NULL,
  threshold REAL NOT NULL,
  observed REAL NOT NULL,
  state TEXT NOT NULL,
  triggered_at INTEGER NOT NULL,
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_events_triggered ON alert_events(triggered_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_rule ON alert_events(rule_id);
`;

export function ensureAlertSchema(): void {
  getDatabase().exec(ddl);
}

export const AlertRuleRepo = {
  list(): AlertRule[] {
    return getDatabase()
      .prepare('SELECT * FROM alert_rules ORDER BY id ASC')
      .all() as AlertRule[];
  },
  enabled(): AlertRule[] {
    return getDatabase()
      .prepare('SELECT * FROM alert_rules WHERE enabled = 1')
      .all() as AlertRule[];
  },
  get(id: number): AlertRule | undefined {
    return getDatabase()
      .prepare('SELECT * FROM alert_rules WHERE id = ?')
      .get(id) as AlertRule | undefined;
  },
  create(input: Omit<AlertRule, 'id' | 'created_at'>): AlertRule {
    const stmt = getDatabase().prepare(
      `INSERT INTO alert_rules
       (name, metric, condition, threshold, duration_s, gpu_index, enabled, notify_browser, notify_sound, cooldown_s, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const r = stmt.run(
      input.name, input.metric, input.condition, input.threshold,
      input.duration_s, input.gpu_index, input.enabled,
      input.notify_browser, input.notify_sound, input.cooldown_s,
      Math.floor(Date.now() / 1000)
    );
    return this.get(Number(r.lastInsertRowid))!;
  },
  update(id: number, patch: Partial<Omit<AlertRule, 'id' | 'created_at'>>): AlertRule | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const merged = { ...cur, ...patch };
    getDatabase().prepare(
      `UPDATE alert_rules SET name=?, metric=?, condition=?, threshold=?, duration_s=?,
       gpu_index=?, enabled=?, notify_browser=?, notify_sound=?, cooldown_s=? WHERE id=?`
    ).run(
      merged.name, merged.metric, merged.condition, merged.threshold, merged.duration_s,
      merged.gpu_index, merged.enabled ? 1 : 0,
      merged.notify_browser ? 1 : 0, merged.notify_sound ? 1 : 0, merged.cooldown_s, id
    );
    return this.get(id);
  },
  delete(id: number): void {
    getDatabase().prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
  },
};

export const AlertEventRepo = {
  insert(e: Omit<AlertEvent, 'id'>): AlertEvent {
    const r = getDatabase().prepare(
      `INSERT INTO alert_events
       (rule_id, rule_name, gpu_index, metric, threshold, observed, state, triggered_at, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(e.rule_id, e.rule_name, e.gpu_index, e.metric, e.threshold, e.observed, e.state, e.triggered_at, e.message);
    return { ...e, id: Number(r.lastInsertRowid) };
  },
  list(limit = 100, sinceEpoch?: number): AlertEvent[] {
    if (sinceEpoch) {
      return getDatabase().prepare(
        'SELECT * FROM alert_events WHERE triggered_at >= ? ORDER BY triggered_at DESC LIMIT ?'
      ).all(sinceEpoch, limit) as AlertEvent[];
    }
    return getDatabase().prepare(
      'SELECT * FROM alert_events ORDER BY triggered_at DESC LIMIT ?'
    ).all(limit) as AlertEvent[];
  },
  pruneOlderThan(epoch: number): number {
    const r = getDatabase().prepare('DELETE FROM alert_events WHERE triggered_at < ?').run(epoch);
    return Number(r.changes || 0);
  },
};
