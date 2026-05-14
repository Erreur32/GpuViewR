// End-to-end ingest test. Spawns an http server, mounts the agent WS,
// creates a fake agent client, and asserts:
//   1. A correct token + host_id authenticates and a 'welcome' arrives.
//   2. A 'sample' frame produces a metricsBus 'sample' event tagged
//      with the SESSION host_id (not whatever the frame claims).
//   3. Bad credentials cause a 4001 close.
//
// Runs in-process with `:memory:` SQLite via _setDatabaseForTests so
// nothing touches data/.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { WebSocket } from 'ws';
import { _setDatabaseForTests, closeDatabase } from '../database/connection.js';
import { HostsRepo } from '../database/models/Host.js';
import { authenticateAgent, setupAgentIngestWS } from './agentIngestWS.js';
import { metricsBus, type SampleEvent, type HostStatusEvent } from './_metricsBus.js';
import type { GpuSample } from './_nvidiaParsers.js';

let server: http.Server;
let baseUrl: string;
const VALID_TOKEN = 'gpvr_test-fixture-token-not-secret';
const VALID_HOST_ID = 'aa11bb22-cc33-dd44-ee55-ff6677889900';

function fakeSample(idx: number): GpuSample {
  return {
    gpu_index: idx, name: 'Test', uuid: null, driver_version: null,
    temperature: 60, utilization: 50, memory_used: 1024, memory_total: 8192,
    power: 100, fan_speed: null, clock_graphics: null, clock_memory: null,
    pci_bus_id: null, pcie_gen_current: null, pcie_gen_max: null,
    pcie_width_current: null, pcie_width_max: null,
    pcie_rx_kbps: null, pcie_tx_kbps: null,
    timestamp: '2026-01-01 00:00:00', timestamp_epoch: 1735689600,
  };
}

before(async () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDatabaseForTests(db);

  // Seed an agent host with a known token
  const token_hash = await bcrypt.hash(VALID_TOKEN, 4); // low rounds = faster test
  HostsRepo.insert({
    id: VALID_HOST_ID,
    label: 'integration-test',
    kind: 'agent',
    token_hash,
    status: 'pending',
  });

  server = http.createServer();
  const wss = setupAgentIngestWS('0.3.0-test');
  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '/').split('?')[0];
    if (path === '/agent') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `ws://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase();
});

function connect(token: string, host_id: string): WebSocket {
  return new WebSocket(`${baseUrl}/agent?token=${encodeURIComponent(token)}&host_id=${encodeURIComponent(host_id)}`);
}

test('authenticateAgent: rejects local host_id', async () => {
  const r = await authenticateAgent(VALID_TOKEN, 'local');
  assert.equal(r, null);
});

test('authenticateAgent: rejects unknown id', async () => {
  const r = await authenticateAgent(VALID_TOKEN, 'nope-not-a-host');
  assert.equal(r, null);
});

test('authenticateAgent: accepts matching token + id', async () => {
  const r = await authenticateAgent(VALID_TOKEN, VALID_HOST_ID);
  assert.ok(r);
  assert.equal(r!.id, VALID_HOST_ID);
});

test('authenticateAgent: rejects wrong token for valid host', async () => {
  const r = await authenticateAgent('wrong-secret', VALID_HOST_ID);
  assert.equal(r, null);
});

test('WS: valid handshake yields welcome + host_status online', async () => {
  const ws = connect(VALID_TOKEN, VALID_HOST_ID);
  const messages: unknown[] = [];
  // Register synchronously so the welcome — which the server sends
  // immediately on connection — isn't missed by an even-loop tick lag.
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });
  const statusEvents: HostStatusEvent[] = [];
  const onStatus = (e: HostStatusEvent) => statusEvents.push(e);
  metricsBus.on('host_status', onStatus);

  try {
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 2000);
    });
    // Give the server a tick to send welcome + emit host_status
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    ws.close();
    metricsBus.off('host_status', onStatus);
  }

  assert.ok(messages.length >= 1, 'no message received');
  const welcome = messages[0] as { type: string; hub_version: string; protocol_ver: number };
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.hub_version, '0.3.0-test');
  assert.equal(welcome.protocol_ver, 1);

  assert.equal(statusEvents.length, 1, 'host_status not emitted');
  assert.equal(statusEvents[0].host_id, VALID_HOST_ID);
  assert.equal(statusEvents[0].status, 'online');
});

test('WS: sample frame is re-emitted on metricsBus tagged with session host_id', async () => {
  const samplesReceived: SampleEvent[] = [];
  const onSample = (e: SampleEvent) => samplesReceived.push(e);
  metricsBus.on('sample', onSample);

  const ws = connect(VALID_TOKEN, VALID_HOST_ID);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 2000);
    });

    // Wait briefly for the welcome to arrive (server-side state is ready)
    await new Promise((r) => setTimeout(r, 100));

    // Send a sample frame with a DECOY host_id — the server must ignore it
    // and tag with the session id (VALID_HOST_ID) instead.
    ws.send(JSON.stringify({
      type: 'sample',
      ts_epoch: 1735689600,
      host_id: 'this-should-be-ignored-by-server',
      samples: [fakeSample(0), fakeSample(1)],
    }));

    // Wait for bus to receive it
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    ws.close();
    metricsBus.off('sample', onSample);
  }

  assert.ok(samplesReceived.length >= 1, 'metricsBus did not receive sample');
  const last = samplesReceived[samplesReceived.length - 1];
  assert.equal(last.host_id, VALID_HOST_ID, 'host_id must come from session, not frame');
  assert.equal(last.samples.length, 2);
  assert.equal(last.samples[0].gpu_index, 0);
  assert.equal(last.samples[1].gpu_index, 1);
});

test('WS: bad token gets 4001 close', async () => {
  const ws = connect('wrong-token', VALID_HOST_ID);
  const closeCode = await new Promise<number>((resolve, reject) => {
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => { /* close happens after */ });
    setTimeout(() => reject(new Error('close timeout')), 2000);
  });
  assert.equal(closeCode, 4001);
});

test('WS: host_id=local is refused', async () => {
  const ws = connect(VALID_TOKEN, 'local');
  const closeCode = await new Promise<number>((resolve, reject) => {
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => { /* ignore */ });
    setTimeout(() => reject(new Error('close timeout')), 2000);
  });
  assert.equal(closeCode, 4001);
});

test('WS: ping yields pong', async () => {
  const ws = connect(VALID_TOKEN, VALID_HOST_ID);
  const messages: Array<{ type: string }> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('connect timeout')), 2000);
    });
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    await new Promise((r) => setTimeout(r, 100));
    ws.send(JSON.stringify({ type: 'ping' }));
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    ws.close();
  }

  const pong = messages.find((m) => m.type === 'pong');
  assert.ok(pong, 'no pong received');
});
