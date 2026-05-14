import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ensureHostsSchema, HostsRepo, LOCAL_HOST_ID } from './models/Host.js';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initializeDatabase() first.');
  return db;
}

/**
 * Idempotent fresh-install schema. Tables include the post-multi-host
 * `host_id` columns from the start so brand-new installs skip the
 * migration block entirely.
 *
 * Compat note: kept aligned with bigsk1/gpu-monitor's gpu_metrics
 * layout (col names, types) plus the host_id column. Importing
 * legacy histories is documented in Docs/MIGRATION.md.
 */
export function applySchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gpu_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL DEFAULT 'local',
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

    CREATE INDEX IF NOT EXISTS idx_gpu_metrics_epoch
      ON gpu_metrics(timestamp_epoch);
    CREATE INDEX IF NOT EXISTS idx_gpu_metrics_gpu_epoch
      ON gpu_metrics(gpu_index, timestamp_epoch);

    CREATE TABLE IF NOT EXISTS gpu_devices (
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
  ensureHostsSchema(database);
}

/**
 * Apply all idempotent in-place migrations needed to bring an existing
 * DB up to the current schema. Each block is independent and detects
 * "already applied" via PRAGMA table_info, so re-running is safe.
 *
 * Order matters: utilization-relax (pre-0.1.6) runs before multi-host
 * because the latter rebuilds gpu_devices and assumes gpu_metrics is
 * already in its modern shape.
 *
 * Crash recovery: any *_new table left over from a half-applied
 * rebuild (CREATE NEW / INSERT / DROP OLD / RENAME) gets dropped at
 * the top of this function before we retry — so a power-cut between
 * the INSERT and the RENAME doesn't wedge subsequent boots.
 */
export function runMigrations(database: Database.Database): void {
  // Drop any orphan rebuild tables from a previous interrupted run.
  for (const table of ['gpu_metrics_new', 'gpu_devices_new']) {
    database.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  migrateUtilizationNotNull(database);
  migrateMultiHost(database);
}

/**
 * Pre-0.1.6 installs had `utilization REAL NOT NULL` and stored fake 0%
 * for "[N/A]" drivers. Modern schema makes it nullable so the UI can
 * show "N/A". SQLite has no DROP NOT NULL — rebuild via CREATE NEW /
 * INSERT / DROP / RENAME.
 */
function migrateUtilizationNotNull(database: Database.Database): void {
  const cols = database
    .prepare("PRAGMA table_info(gpu_metrics)")
    .all() as Array<{ name: string; notnull: number }>;
  const utilCol = cols.find((c) => c.name === 'utilization');
  if (utilCol?.notnull !== 1) return;
  logger.info('DB', 'Migrating gpu_metrics: relaxing utilization NOT NULL...');
  database.exec(`
    BEGIN;
    CREATE TABLE gpu_metrics_new (
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
    INSERT INTO gpu_metrics_new
      SELECT id, gpu_index, timestamp, timestamp_epoch, temperature,
             utilization, memory_used, memory_total, power, fan_speed,
             clock_graphics, clock_memory FROM gpu_metrics;
    DROP TABLE gpu_metrics;
    ALTER TABLE gpu_metrics_new RENAME TO gpu_metrics;
    CREATE INDEX idx_gpu_metrics_epoch ON gpu_metrics(timestamp_epoch);
    CREATE INDEX idx_gpu_metrics_gpu_epoch ON gpu_metrics(gpu_index, timestamp_epoch);
    COMMIT;
  `);
  logger.success('DB', 'gpu_metrics migration complete.');
}

/**
 * v0.2.x -> v0.3.x multi-host migration. Three sub-steps:
 *
 *  1. gpu_metrics + alert_events: add host_id via ALTER TABLE ADD COLUMN
 *     (cheap, constant DEFAULT 'local' backfills every existing row).
 *  2. gpu_devices: PK changes from (gpu_index) to (host_id, gpu_index).
 *     SQLite can't alter a PK in place — rebuild via CREATE NEW /
 *     INSERT / DROP / RENAME.
 *  3. alert_rules: add nullable host_id (NULL = global rule, default).
 *
 * Plus: ensure the `hosts` table exists and seed the local host row.
 *
 * Each sub-step is keyed off PRAGMA table_info so reruns are no-ops.
 */
function migrateMultiHost(database: Database.Database): void {
  ensureHostsSchema(database);
  HostsRepo.seedLocalIfMissing(database);

  // -- gpu_metrics: ADD COLUMN host_id (legacy v0.2.x DB) — the
  //    host-prefixed index is created unconditionally below because
  //    applySchema can't reference host_id on a still-legacy table.
  const metricsCols = database
    .prepare("PRAGMA table_info(gpu_metrics)")
    .all() as Array<{ name: string }>;
  if (!metricsCols.some((c) => c.name === 'host_id')) {
    logger.info('DB', 'Migrating gpu_metrics: adding host_id column...');
    database.exec(`ALTER TABLE gpu_metrics ADD COLUMN host_id TEXT NOT NULL DEFAULT '${LOCAL_HOST_ID}';`);
    logger.success('DB', 'gpu_metrics host_id column added.');
  }
  // Idempotent: present on fresh + migrated installs alike.
  database.exec(`CREATE INDEX IF NOT EXISTS idx_gpu_metrics_host_gpu_epoch ON gpu_metrics(host_id, gpu_index, timestamp_epoch);`);

  // -- gpu_devices: PK rebuild (gpu_index -> (host_id, gpu_index))
  const devCols = database
    .prepare("PRAGMA table_info(gpu_devices)")
    .all() as Array<{ name: string; pk: number }>;
  const devHasHostId = devCols.some((c) => c.name === 'host_id');
  const devPkIsHostScoped = devCols.find((c) => c.name === 'host_id')?.pk === 1;
  if (!devHasHostId || !devPkIsHostScoped) {
    logger.info('DB', 'Migrating gpu_devices: rebuilding with composite PK (host_id, gpu_index)...');
    database.exec(`
      BEGIN;
      CREATE TABLE gpu_devices_new (
        host_id TEXT NOT NULL DEFAULT '${LOCAL_HOST_ID}',
        gpu_index INTEGER NOT NULL,
        name TEXT NOT NULL,
        uuid TEXT,
        memory_total REAL,
        driver_version TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (host_id, gpu_index)
      );
      INSERT INTO gpu_devices_new (host_id, gpu_index, name, uuid, memory_total, driver_version, first_seen, last_seen)
        SELECT '${LOCAL_HOST_ID}', gpu_index, name, uuid, memory_total, driver_version, first_seen, last_seen FROM gpu_devices;
      DROP TABLE gpu_devices;
      ALTER TABLE gpu_devices_new RENAME TO gpu_devices;
      COMMIT;
    `);
    logger.success('DB', 'gpu_devices migration complete.');
  }

  // -- alert_events / alert_rules: ADD COLUMN host_id. Schema may not
  //    exist yet (created lazily by alertService.init); guard with
  //    sqlite_master lookup before PRAGMA.
  const alertEventsExists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alert_events'")
    .get();
  if (alertEventsExists) {
    const cols = database
      .prepare("PRAGMA table_info(alert_events)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'host_id')) {
      database.exec(`ALTER TABLE alert_events ADD COLUMN host_id TEXT NOT NULL DEFAULT '${LOCAL_HOST_ID}';`);
      logger.success('DB', 'alert_events host_id column added.');
    }
  }

  const alertRulesExists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alert_rules'")
    .get();
  if (alertRulesExists) {
    const cols = database
      .prepare("PRAGMA table_info(alert_rules)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'host_id')) {
      database.exec(`ALTER TABLE alert_rules ADD COLUMN host_id TEXT;`);
      logger.success('DB', 'alert_rules host_id column added (nullable = global).');
    }
  }
}

export function initializeDatabase(): Database.Database {
  if (db) return db;

  if (!fs.existsSync(config.dataDir)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
  const dbPath = path.join(config.dataDir, 'gpuviewr.db');
  logger.info('DB', `Opening SQLite at ${dbPath}`);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');

  applySchema(db);
  runMigrations(db);

  logger.success('DB', 'Schema ready');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Test-only: replace the module-level singleton with an arbitrary
 * Database instance (typically `:memory:`) so unit tests can drive
 * HostsRepo/GpuMetricRepository/AlertEventRepo without writing to
 * the dev data dir. Caller is responsible for closing the instance
 * (via closeDatabase or directly).
 *
 * Runs applySchema + runMigrations on the instance so it's usable
 * immediately. Not exported through any production code path; only
 * imported by *.test.ts files.
 */
export function _setDatabaseForTests(database: Database.Database): void {
  if (db) db.close();
  db = database;
  applySchema(db);
  runMigrations(db);
}
