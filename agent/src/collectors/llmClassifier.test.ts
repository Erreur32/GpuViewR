import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLLM } from './llmClassifier.js';

const BLOB = 'a3de86cd1c132c822487ededd47a324c50491393e6565cd14bafa40d0b8e686f';

test('classifyLLM: ollama-bundled llama-server resolves the blob digest', () => {
  const cmd = `/usr/lib/ollama/llama-server --model /usr/share/ollama/.ollama/models/blobs/sha256-${BLOB} --port 41234`;
  const resolvers = { ollamaModelByDigest: (d: string) => (d === `sha256:${BLOB}` ? 'llama3.1:8b' : null) };
  assert.deepEqual(classifyLLM(cmd, resolvers), { runtime: 'ollama', model: 'llama3.1:8b' });
});

test('classifyLLM: ollama falls back to the digest prefix without a resolver', () => {
  const cmd = `/usr/bin/ollama runner --model /root/.ollama/models/blobs/sha256-${BLOB}`;
  assert.deepEqual(classifyLLM(cmd), { runtime: 'ollama', model: `sha256:${BLOB.slice(0, 12)}` });
});

test('classifyLLM: llama.cpp -m keeps the file basename', () => {
  assert.deepEqual(classifyLLM('/app/llama-server -m /models/qwen3-8b-Q4_K_M.gguf --port 8080'), {
    runtime: 'llamacpp', model: 'qwen3-8b-Q4_K_M.gguf',
  });
});

test('classifyLLM: llama.cpp -hf surfaces the Hugging Face repo', () => {
  const cmd = '/app/llama-server -hf unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q5_K_M --port 8080 --alias qwen3-coder-30b';
  assert.deepEqual(classifyLLM(cmd), { runtime: 'llamacpp', model: 'Qwen3-Coder-30B-A3B-Instruct-GGUF:Q5_K_M' });
});

test('classifyLLM: llama.cpp --alias used when no model flag', () => {
  assert.deepEqual(classifyLLM('/app/llama-server --alias my-model --port 8080'), {
    runtime: 'llamacpp', model: 'my-model',
  });
});

test('classifyLLM: null command yields empty result', () => {
  assert.deepEqual(classifyLLM(null), { runtime: null, model: null });
});
