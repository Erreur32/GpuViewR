// Verifies the multi-host migration on a synthetic v0.2.5 schema.
// Uses an in-memory SQLite DB and the standalone applySchema/runMigrations
// exports so we don't touch the module-level singleton or the dev data dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applySchema, runMigrations } from './connection.js';

// Note: since v0.5 the local 'hosts' row is no longer seeded by runMigrations.
// It is upserted on the sidecar agent's first WS handshake (upsertLocalSidecarHost
// in agentIngestWS.ts). In aggregator-only mode the row legitimately stays absent.
// These tests therefore assert schema shape and data preservation, not host seeding.

function buildV025Schema(db: Database.Database): void {
  // Snapshot of the schema as it was BEFORE the multi-host migration —
  // matches the gpu_metrics + gpu_devices DDL from v0.2.5 verbatim.
  db.exec(`
    CREATE TABLE gpu_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gpu_index INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL,
      temperature REAL NOT NULL,
      utilization REAL,
      memory_used REAL NOT NULL,
      memory_total REAL,
      power REAL NOT NULL,
      fan_speed REAL,
      clock_graphics REAL,
      clock_memory REAL
    );
    CREATE INDEX idx_gpu_metrics_epoch ON gpu_metrics(timestamp_epoch);
    CREATE INDEX idx_gpu_metrics_gpu_epoch ON gpu_metrics(gpu_index, timestamp_epoch);

    CREATE TABLE gpu_devices (
      gpu_index INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      memory_total REAL,
      driver_version TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE alert_rules (
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
      notify_webhook INTEGER NOT NULL DEFAULT 1,
      cooldown_s INTEGER NOT NULL DEFAULT 300,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE alert_events (
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
  `);
}

function seedV025Data(db: Database.Database): void {
  db.exec(`
    INSERT INTO gpu_metrics (gpu_index, timestamp, timestamp_epoch, temperature, utilization, memory_used, memory_total, power, fan_speed, clock_graphics, clock_memory)
    VALUES
      (0, '2026-01-01 12:00:00', 1735732800, 65, 80, 8000, 24576, 250, 60, 1800, 9500),
      (1, '2026-01-01 12:00:00', 1735732800, 70, 90, 12000, 24576, 300, 70, 1900, 9500);

    INSERT INTO gpu_devices (gpu_index, name, uuid, memory_total, driver_version, first_seen, last_seen)
    VALUES
      (0, 'RTX 4090', 'GPU-aaa', 24576, '550.54', 1735732700, 1735732800),
      (1, 'RTX 4090', 'GPU-bbb', 24576, '550.54', 1735732700, 1735732800);

    INSERT INTO alert_events (rule_id, rule_name, gpu_index, metric, threshold, observed, state, triggered_at, message)
    VALUES (1, 'Hot GPU', 0, 'temperature', 80, 85, 'firing', 1735732800, 'Hot GPU triggered');
  `);
}

test('migration: fresh install (no legacy tables) creates multi-host schema', () => {
  const db = new Database(':memory:');
  try {
    applySchema(db);
    runMigrations(db);

    // hosts table exists and is empty on a fresh aggregator-only install
    // (the sidecar handshake is what creates the local row, see header note)
    const hostsRows = db.prepare('SELECT id FROM hosts').all() as Array<{ id: string }>;
    assert.equal(hostsRows.length, 0, 'hosts should be empty on fresh install without sidecar handshake');

    // gpu_metrics has host_id column
    const cols = db.prepare("PRAGMA table_info(gpu_metrics)").all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === 'host_id'), 'gpu_metrics.host_id missing on fresh install');

    // gpu_devices PK is composite
    const devCols = db.prepare("PRAGMA table_info(gpu_devices)").all() as Array<{ name: string; pk: number }>;
    const hostIdPk = devCols.find((c) => c.name === 'host_id')?.pk;
    const gpuIndexPk = devCols.find((c) => c.name === 'gpu_index')?.pk;
    assert.ok(hostIdPk! > 0 && gpuIndexPk! > 0, 'gpu_devices PK should include host_id and gpu_index');
  } finally {
    db.close();
  }
});

test('migration: v0.2.5 schema preserves row count and backfills host_id=local', () => {
  const db = new Database(':memory:');
  try {
    buildV025Schema(db);
    seedV025Data(db);
    const preMetrics = (db.prepare('SELECT COUNT(*) as n FROM gpu_metrics').get() as { n: number }).n;
    const preDevices = (db.prepare('SELECT COUNT(*) as n FROM gpu_devices').get() as { n: number }).n;
    const preEvents = (db.prepare('SELECT COUNT(*) as n FROM alert_events').get() as { n: number }).n;

    runMigrations(db);

    // Row counts preserved
    const postMetrics = (db.prepare('SELECT COUNT(*) as n FROM gpu_metrics').get() as { n: number }).n;
    const postDevices = (db.prepare('SELECT COUNT(*) as n FROM gpu_devices').get() as { n: number }).n;
    const postEvents = (db.prepare('SELECT COUNT(*) as n FROM alert_events').get() as { n: number }).n;
    assert.equal(postMetrics, preMetrics);
    assert.equal(postDevices, preDevices);
    assert.equal(postEvents, preEvents);

    // Every legacy row got host_id='local'
    const orphanMetrics = (db.prepare("SELECT COUNT(*) as n FROM gpu_metrics WHERE host_id != 'local'").get() as { n: number }).n;
    const orphanDevices = (db.prepare("SELECT COUNT(*) as n FROM gpu_devices WHERE host_id != 'local'").get() as { n: number }).n;
    const orphanEvents = (db.prepare("SELECT COUNT(*) as n FROM alert_events WHERE host_id != 'local'").get() as { n: number }).n;
    assert.equal(orphanMetrics, 0, 'gpu_metrics has rows with host_id != local');
    assert.equal(orphanDevices, 0, 'gpu_devices has rows with host_id != local');
    assert.equal(orphanEvents, 0, 'alert_events has rows with host_id != local');

    // alert_rules.host_id added nullable (NULL = global default)
    const ruleCols = db.prepare("PRAGMA table_info(alert_rules)").all() as Array<{ name: string; notnull: number }>;
    const hostIdCol = ruleCols.find((c) => c.name === 'host_id');
    assert.ok(hostIdCol, 'alert_rules.host_id column missing');
    assert.equal(hostIdCol!.notnull, 0, 'alert_rules.host_id should be nullable (NULL = global)');
  } finally {
    db.close();
  }
});

test('migration: idempotent — running twice yields the same state', () => {
  const db = new Database(':memory:');
  try {
    buildV025Schema(db);
    seedV025Data(db);

    runMigrations(db);
    const afterFirst = db.prepare('SELECT COUNT(*) as n FROM gpu_metrics').get() as { n: number };

    runMigrations(db);
    const afterSecond = db.prepare('SELECT COUNT(*) as n FROM gpu_metrics').get() as { n: number };

    assert.equal(afterFirst.n, afterSecond.n, 'row count must stay stable across repeated runMigrations calls');
  } finally {
    db.close();
  }
});

test('migration: orphan gpu_devices_new from a crashed run is dropped on next boot', () => {
  const db = new Database(':memory:');
  try {
    buildV025Schema(db);
    seedV025Data(db);
    // Simulate a crash mid-migration: gpu_devices_new exists but rename
    // never happened. The next boot should drop it cleanly and complete
    // the migration.
    db.exec(`
      CREATE TABLE gpu_devices_new (
        host_id TEXT NOT NULL DEFAULT 'local',
        gpu_index INTEGER NOT NULL,
        name TEXT NOT NULL,
        uuid TEXT,
        memory_total REAL,
        driver_version TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (host_id, gpu_index)
      );
    `);

    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gpu_devices%'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();
    assert.deepEqual(names, ['gpu_devices'], 'gpu_devices_new should have been dropped');

    const postDevices = (db.prepare('SELECT COUNT(*) as n FROM gpu_devices').get() as { n: number }).n;
    assert.equal(postDevices, 2, 'gpu_devices rows should survive crash recovery');
  } finally {
    db.close();
  }
});
