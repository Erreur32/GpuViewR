import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { _setDatabaseForTests, closeDatabase } from '../database/connection.js';
import { GpuDeviceRepository, GpuMetricRepository } from '../database/models/GpuMetric.js';
import { HostsRepo, LOCAL_HOST_ID } from '../database/models/Host.js';
import type { GpuSample } from './parsers/nvidia.js';
import {
  __testOnly,
  startAgentMetricsPersistor,
  stopAgentMetricsPersistor,
} from './agentMetricsPersistor.js';

const REMOTE_HOST = 'aa111111-2222-3333-4444-555555555555';

function makeSample(idx: number, name = 'Remote GPU'): GpuSample {
  return {
    gpu_index: idx,
    name,
    uuid: `UUID-${idx}`,
    driver_version: '1.2.3',
    temperature: 42,
    utilization: 17,
    memory_used: 512,
    memory_total: 8192,
    power: 75,
    fan_speed: null,
    clock_graphics: 1500,
    clock_memory: null,
    pci_bus_id: null,
    pcie_gen_current: null,
    pcie_gen_max: null,
    pcie_width_current: null,
    pcie_width_max: null,
    pcie_rx_kbps: null,
    pcie_tx_kbps: null,
    timestamp: '2026-01-01 00:00:00',
    timestamp_epoch: 1735689600 + idx,
  };
}

before(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDatabaseForTests(db);
  HostsRepo.insert({
    id: REMOTE_HOST,
    label: 'persistor-test',
    kind: 'agent',
    token_hash: null,
    status: 'online',
  });
  startAgentMetricsPersistor();
});

after(() => {
  stopAgentMetricsPersistor();
  closeDatabase();
});

test('persistor: remote sample upserts device row + buffers metric', () => {
  __testOnly.onSample({ host_id: REMOTE_HOST, samples: [makeSample(0)] });

  const devices = GpuDeviceRepository.listByHost(REMOTE_HOST);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].gpu_index, 0);
  assert.equal(devices[0].name, 'Remote GPU');

  // Buffer holds the metric row until the next flush; nothing in
  // gpu_metrics yet.
  assert.equal(__testOnly.peekBufferSize(), 1);
  assert.equal(GpuMetricRepository.history(REMOTE_HOST, 0, 0).length, 0);
});

test('persistor: flush moves the buffered metrics into gpu_metrics', () => {
  __testOnly.flush();
  const rows = GpuMetricRepository.history(REMOTE_HOST, 0, 0);
  assert.ok(rows.length >= 1, 'expected at least one row after flush');
  assert.equal(rows[rows.length - 1].temperature, 42);
  assert.equal(__testOnly.peekBufferSize(), 0);
});

test('persistor: local host samples ARE persisted (post-v0.8 single path)', () => {
  // Pre-v0.5 the hub had its own gpuCollector that persisted local
  // samples inline before re-emitting them on the bus, so this
  // persistor skipped LOCAL_HOST_ID to avoid double-writes. v0.5+
  // removed gpuCollector entirely — the local sidecar now pushes via
  // the same WebSocket path as remote agents. The defensive skip
  // turned out to be silently dropping every local sample from
  // gpu_metrics, visible as "master missing from /fleet's 1h/24h
  // chart" because live charts use the in-memory store while non-
  // live charts hit the SQLite history that wasn't being written.
  // Removed in v0.8.
  const before = GpuMetricRepository.history(LOCAL_HOST_ID, 0, 0).length;
  __testOnly.onSample({ host_id: LOCAL_HOST_ID, samples: [makeSample(0)] });
  __testOnly.flush();
  const after = GpuMetricRepository.history(LOCAL_HOST_ID, 0, 0).length;
  assert.equal(after, before + 1, 'local samples must be persisted in gpu_metrics');
  // Device row for LOCAL is upserted so the /fleet history chart can
  // resolve a name + memory_total for the master.
  const localDevices = GpuDeviceRepository.listByHost(LOCAL_HOST_ID);
  assert.equal(localDevices.length, 1);
});

test('persistor: empty sample array is a no-op', () => {
  const beforeBuf = __testOnly.peekBufferSize();
  __testOnly.onSample({ host_id: REMOTE_HOST, samples: [] });
  assert.equal(__testOnly.peekBufferSize(), beforeBuf);
});

test('persistor: multiple GPUs on the same host each get a device row', () => {
  __testOnly.onSample({
    host_id: REMOTE_HOST,
    samples: [makeSample(1, 'Remote GPU #1'), makeSample(2, 'Remote GPU #2')],
  });
  __testOnly.flush();
  const devices = GpuDeviceRepository.listByHost(REMOTE_HOST);
  const indices = devices.map((d) => d.gpu_index).sort();
  assert.deepEqual(indices, [0, 1, 2]);
});
