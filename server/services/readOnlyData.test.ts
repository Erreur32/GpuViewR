import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { _setDatabaseForTests, closeDatabase } from '../database/connection.js';
import { HostsRepo } from '../database/models/Host.js';
import { GpuDeviceRepository, GpuMetricRepository } from '../database/models/GpuMetric.js';
import { AppConfigRepo, ensureAppConfigSchema } from '../database/models/AppConfig.js';
import { agentProcessStore } from './agentProcessStore.js';
import { fleetGpuStats, fleetLlmProcesses, healthSummary, listHosts } from './readOnlyData.js';
import { llmServerInfo } from './llmEndpoint.js';

before(() => {
  _setDatabaseForTests(new Database(':memory:'));
  ensureAppConfigSchema();
});
after(() => {
  closeDatabase();
});

test('listHosts: ips as a list, capabilities kept as string plus capabilities_object, no token hash', () => {
  HostsRepo.insert({
    id: 'h1', label: 'Deb13', kind: 'agent', token_hash: 'secret-hash',
    capabilities: JSON.stringify({ gpu: true, processes: true }),
  });
  HostsRepo.setIdentity('h1', 'deb13', ['192.168.32.209']);
  HostsRepo.setRemoteAddr('h1', '192.168.32.209');
  HostsRepo.insert({ id: 'h2', label: 'old-agent', kind: 'agent', token_hash: 'x' });

  const [h1, h2] = listHosts() as Array<Record<string, unknown>>;
  assert.equal(h1.hostname, 'deb13');
  assert.deepEqual(h1.ips, ['192.168.32.209']);
  assert.equal(h1.remote_addr, '192.168.32.209');
  assert.equal(h1.capabilities, '{"gpu":true,"processes":true}');
  assert.deepEqual(h1.capabilities_object, { gpu: true, processes: true });
  assert.equal('token_hash' in h1, false);
  assert.deepEqual(h2.ips, []);
  assert.equal(h2.remote_addr, null);
  assert.equal(h2.capabilities_object, null);
});

test('fleetGpuStats: one row per host + GPU inside the window, with labels', () => {
  const now = Math.floor(Date.now() / 1000);
  const metric = (host_id: string, gpu_index: number, ago: number, temperature: number) => ({
    host_id, gpu_index, timestamp: '', timestamp_epoch: now - ago, temperature, utilization: 50,
    memory_used: 1000, memory_total: 8000, power: 100, fan_speed: null, clock_graphics: null, clock_memory: null,
  });
  GpuMetricRepository.insertMany([
    metric('h1', 0, 10, 40), metric('h1', 0, 20, 60),
    metric('h1', 1, 10, 70),
    metric('h2', 0, 10, 30),
    metric('h2', 0, 3 * 86400, 99), // outside 24h
  ]);
  GpuDeviceRepository.upsert({ host_id: 'h1', gpu_index: 0, name: 'RTX 3060 Ti', uuid: null, memory_total: 8000, driver_version: null });

  const r = fleetGpuStats('24h');
  assert.equal(r.count, 3);
  const first = r.stats[0] as Record<string, unknown>;
  assert.deepEqual(
    { host_id: first.host_id, host_label: first.host_label, gpu_index: first.gpu_index, gpu_name: first.gpu_name, samples: first.samples },
    { host_id: 'h1', host_label: 'Deb13', gpu_index: 0, gpu_name: 'RTX 3060 Ti', samples: 2 },
  );
  assert.equal(first.temp_min, 40);
  assert.equal(first.temp_max, 60);
  assert.equal(first.temp_avg, 50);
  assert.equal((r.stats[2] as Record<string, unknown>).temp_max, 30);
});

test('llmServerInfo: port from the cmdline, else the runtime default; alias when given', () => {
  assert.deepEqual(
    llmServerInfo('llamacpp', '/app/llama-server -m /models/q.gguf --port 8081 --alias qwen3-coder-30b'),
    { llm_port: 8081, llm_port_source: 'cmdline', llm_alias: 'qwen3-coder-30b' },
  );
  assert.deepEqual(llmServerInfo('llamacpp', 'llama-server -m q.gguf -a coder'), { llm_port: 8080, llm_port_source: 'default', llm_alias: 'coder' });
  assert.equal(llmServerInfo('llamacpp', 'python -m llama_cpp.server --model x.gguf').llm_port, 8000);
  assert.deepEqual(llmServerInfo('vllm', 'vllm serve m --port=9000 --served-model-name chat'), { llm_port: 9000, llm_port_source: 'cmdline', llm_alias: 'chat' });
  // The Ollama runner's --port is internal; the API stays on the daemon port.
  assert.deepEqual(llmServerInfo('ollama', '/usr/bin/ollama runner --model /blobs/sha256-ab --port 41234'), { llm_port: 11434, llm_port_source: 'default', llm_alias: null });
  assert.equal(llmServerInfo('llamacpp', 'llama-server --port 99999').llm_port, 8080);
  assert.deepEqual(llmServerInfo(null, 'llama-server --port 8080'), { llm_port: null, llm_port_source: null, llm_alias: null });
});

test('fleetLlmProcesses: rows carry llm_port and llm_alias', () => {
  agentProcessStore.set('h1', {
    ts: Math.floor(Date.now() / 1000),
    processes: [
      { pid: 1, process_name: 'llama-server', gpu_uuid: 'GPU-x', used_memory: 1, type: 'C', command: 'llama-server -m q.gguf --port 8080 --alias qwen3-coder-30b', cpu_pct: null, gpu_pct: null, llm_runtime: 'llamacpp', llm_model: 'q.gguf' },
      { pid: 2, process_name: 'Xorg', gpu_uuid: 'GPU-x', used_memory: 1, type: 'G', command: 'Xorg', cpu_pct: null, gpu_pct: null },
    ],
  });
  const rows = fleetLlmProcesses() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].llm_port, 8080);
  assert.equal(rows[0].llm_alias, 'qwen3-coder-30b');
});

test('healthSummary: latest release from the update cache, never a network call', () => {
  AppConfigRepo.setJson('update_check_config', { enabled: true, frequencyHours: 24 });
  const checkedAt = new Date().toISOString();
  AppConfigRepo.setJson('update_check_cache', {
    cachedAt: checkedAt,
    result: { enabled: true, currentVersion: '0.13.0', latestVersion: '0.13.1', updateAvailable: true, dockerReady: true, releaseNotes: null, releaseUrl: null, checkedAt, message: '', fromCache: false },
  });
  const h = healthSummary('0.13.0');
  assert.equal(h.latest_version, '0.13.1');
  assert.equal(h.update_available, true);
  assert.equal(h.update_checked_at, checkedAt);
  assert.equal(healthSummary('0.13.1').update_available, false);

  AppConfigRepo.setJson('update_check_config', { enabled: false, frequencyHours: 24 });
  const off = healthSummary('0.13.0');
  assert.equal(off.update_check_enabled, false);
  assert.equal(off.latest_version, null);
  assert.equal(off.update_available, false);
});
