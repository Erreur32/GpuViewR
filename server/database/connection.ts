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

  // Schema — kept compatible with bigsk1/gpu-monitor's gpu_metrics table
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
      utilization REAL NOT NULL,
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

  logger.success('DB', 'Schema ready');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
