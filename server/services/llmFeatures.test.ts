// v0.11.0 hub features: LLM config validation, process alerts, process
// history, webhook wording for host/process alerts.

import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { _setDatabaseForTests, closeDatabase } from '../database/connection.js';
import { ensureAppConfigSchema } from '../database/models/AppConfig.js';
import { llmConfig, LlmConfigError, parseHostConfig, parseRules } from './llmConfig.js';
import { processMatches } from './alertService.js';
import { flushProcessHistory, processHistory, processKey } from './processHistory.js';
import { formatAlert } from './alertFormatter.js';
import type { GpuProcess } from './_processTypes.js';

function proc(over: Partial<GpuProcess>): GpuProcess {
  return {
    pid: 1, process_name: 'llama-server', gpu_uuid: 'ROCm-0000_c5_00_0', used_memory: 0,
    type: 'C', command: null, cpu_pct: null, gpu_pct: null, ...over,
  };
}

before(() => {
  _setDatabaseForTests(new Database(':memory:'));
  ensureAppConfigSchema();
});

after(() => {
  closeDatabase();
});

test('parseRules: valid rules kept, limits and bad input refused', () => {
  assert.deepEqual(parseRules([{ match: ' tabby ', runtime: 'TabbyAPI', model_flag: '--model' }]), [
    { match: 'tabby', runtime: 'TabbyAPI', model_flag: '--model' },
  ]);
  assert.throws(() => parseRules('x'), LlmConfigError);
  assert.throws(() => parseRules([{ match: '', runtime: 'x' }]), /match is required/);
  assert.throws(() => parseRules([{ match: 'a', runtime: 'x', model_flag: 'model' }]), /--model/);
  assert.throws(() => parseRules([{ match: 'a'.repeat(121), runtime: 'x' }]), /longer than 120/);
  assert.throws(() => parseRules([{ match: 'a\nb', runtime: 'x' }]), /control characters/);
  assert.throws(() => parseRules(Array.from({ length: 51 }, () => ({ match: 'a', runtime: 'b' }))), /at most 50/);
});

test('parseHostConfig: http(s) URLs only, normalised, safe dir', () => {
  assert.deepEqual(parseHostConfig({ endpoints: ['http://10.0.0.5:8080/', 'http://10.0.0.5:8080'], ollama_manifests_dir: '/srv/ollama/models/manifests' }), {
    endpoints: ['http://10.0.0.5:8080'],
    ollama_manifests_dir: '/srv/ollama/models/manifests',
  });
  assert.throws(() => parseHostConfig({ endpoints: ['file:///etc/passwd'] }), /http or https/);
  assert.throws(() => parseHostConfig({ endpoints: ['http://u:p@h'] }), /credentials/);
  assert.throws(() => parseHostConfig({ endpoints: ['http://h/?x=1'] }), /query/);
  assert.throws(() => parseHostConfig({ ollama_manifests_dir: 'relative/dir' }), /absolute/);
  assert.throws(() => parseHostConfig({ ollama_manifests_dir: '/srv/../etc' }), /absolute/);
  assert.deepEqual(parseHostConfig({}), { endpoints: [], ollama_manifests_dir: null });
});

test('llmConfig: stored, and the config frame merges rules + host settings', () => {
  llmConfig.setRules([{ match: 'tabby', runtime: 'TabbyAPI' }]);
  llmConfig.setHost('jarvis', { endpoints: ['http://192.168.32.210:8080'] });
  assert.deepEqual(llmConfig.frameFor('jarvis'), {
    type: 'config',
    llm: { rules: [{ match: 'tabby', runtime: 'TabbyAPI' }], endpoints: ['http://192.168.32.210:8080'], ollama_manifests_dir: null },
  });
  assert.deepEqual(llmConfig.frameFor('other').llm.endpoints, []);
});

test('processMatches: case-insensitive on name, command and model', () => {
  const p = proc({ command: '/app/llama-server -hf unsloth/Qwen3', llm_model: 'qwen3-coder-30b' });
  assert.equal(processMatches(p, 'LLAMA-server'), true);
  assert.equal(processMatches(p, 'unsloth'), true);
  assert.equal(processMatches(p, 'coder-30b'), true);
  assert.equal(processMatches(p, 'ollama'), false);
  // Regex metacharacters are plain text.
  assert.equal(processMatches(p, '.*'), false);
});

test('process history: per-minute peak, top by memory, LLM keyed by model', () => {
  processHistory.init();
  const llama = proc({ llm_runtime: 'llamacpp', llm_model: 'qwen3-coder-30b', used_memory: 20_000, gtt_memory: 500, gpu_pct: 40 });
  assert.equal(processKey(llama), 'llamacpp:qwen3-coder-30b');
  processHistory._record({ host_id: 'jarvis', processes: [llama, proc({ pid: 2, process_name: 'Xorg', used_memory: 200 })] });
  processHistory._record({ host_id: 'jarvis', processes: [{ ...llama, used_memory: 26_000, gpu_pct: 60 }] });
  assert.equal(flushProcessHistory(), 2);
  const top = processHistory.top('jarvis', 24);
  assert.equal(top[0].pkey, 'llamacpp:qwen3-coder-30b');
  assert.equal(top[0].vram_max, 26_500);
  assert.equal(top[0].gpu_avg, 50);
  assert.equal(top[1].name, 'Xorg');
  assert.equal(processHistory.top('other', 24).length, 0);
  assert.equal(processHistory.pruneOlderThan(Math.floor(Date.now() / 1000) + 1), 2);
});

test('formatAlert: host and process metrics no longer print undefined', () => {
  const host = formatAlert({ rule_name: 'CPU', gpu_index: -1, metric: 'host_cpu', threshold: 90, observed: 95, state: 'firing' }, 'en');
  assert.match(host.plain, /Host CPU above 90% \(observed 95%\) on host/);
  const absent = formatAlert({ rule_name: 'llama down', gpu_index: -2, metric: 'process_absent', threshold: 0, observed: 1, state: 'firing', process_match: 'llama-server' }, 'fr');
  assert.match(absent.plain, /aucun processus correspondant à "llama-server"/);
  const vram = formatAlert({ rule_name: 'big', gpu_index: -2, metric: 'process_vram', threshold: 1000, observed: 20000, state: 'firing', process_match: 'ollama' }, 'en');
  assert.match(vram.telegram, /<b>20000 MiB<\/b>/);
  assert.doesNotMatch(`${host.plain}${absent.plain}${vram.plain}`, /undefined/);
});
