import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initializeDatabase() first.');
  return db;
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
  // Read perf: 64 MiB page cache + 256 MiB mmap. Cheap on modern hosts and
  // avoids re-reading the same metric pages from disk for repeat range queries.
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');

  // Schema: kept compatible with bigsk1/gpu-monitor's gpu_metrics table
  // so existing histories can be imported (see Docs/MIGRATION.md).
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gpu_metrics (
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

    CREATE INDEX IF NOT EXISTS idx_gpu_metrics_epoch
      ON gpu_metrics(timestamp_epoch);
    CREATE INDEX IF NOT EXISTS idx_gpu_metrics_gpu_epoch
      ON gpu_metrics(gpu_index, timestamp_epoch);

    CREATE TABLE IF NOT EXISTS gpu_devices (
      gpu_index INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      uuid TEXT,
      memory_total REAL,
      driver_version TEXT,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );
  `);

  // Migrate existing tables created with NOT NULL on utilization (pre-0.1.6).
  // Some drivers report utilization.gpu as [N/A]: we now store NULL so the UI
  // can show "N/A" instead of a fake 0%. SQLite has no DROP NOT NULL: rebuild.
  const cols = db
    .prepare("PRAGMA table_info(gpu_metrics)")
    .all() as Array<{ name: string; notnull: number }>;
  const utilCol = cols.find((c) => c.name === 'utilization');
  if (utilCol && utilCol.notnull === 1) {
    logger.info('DB', 'Migrating gpu_metrics: relaxing utilization NOT NULL...');
    db.exec(`
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

  logger.success('DB', 'Schema ready');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
