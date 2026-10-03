import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLLM, type OllamaDigestContext } from './llmClassifier.js';

const BLOB = 'a3de86cd1c132c822487ededd47a324c50491393e6565cd14bafa40d0b8e686f';
const resolvers = { ollamaModelByDigest: (d: string) => (d === `sha256:${BLOB}` ? 'llama3.1:8b' : null) };

test('classifyLLM: ollama-bundled llama-server resolves the blob digest', () => {
  const cmd = `/usr/lib/ollama/llama-server --model /usr/share/ollama/.ollama/models/blobs/sha256-${BLOB} --port 41234`;
  assert.deepEqual(classifyLLM(cmd, resolvers), { runtime: 'ollama', model: 'llama3.1:8b', hint: null });
});

test('classifyLLM: ollama falls back to the digest prefix with a hint', () => {
  const cmd = `/usr/bin/ollama runner --model /root/.ollama/models/blobs/sha256-${BLOB}`;
  assert.deepEqual(classifyLLM(cmd), {
    runtime: 'ollama', model: `sha256:${BLOB.slice(0, 12)}`, hint: 'ollama_manifests',
  });
});

test('classifyLLM: ollama resolver gets the blob path and pid', () => {
  let seen: OllamaDigestContext | undefined;
  const spy = { ollamaModelByDigest: (_d: string, ctx?: OllamaDigestContext) => { seen = ctx; return null; } };
  const path = `/root/.ollama/models/blobs/sha256-${BLOB}`;
  classifyLLM(`/usr/lib/ollama/llama-server --model ${path} --port 42291`, spy, 2258929);
  assert.deepEqual(seen, { blobPath: path, pid: 2258929 });
});

test('classifyLLM: ollama serve is ollama, no model, no hint', () => {
  assert.deepEqual(classifyLLM('/bin/ollama serve'), { runtime: 'ollama', model: null, hint: null });
});

test('classifyLLM: Windows ollama.exe with a quoted path', () => {
  const cmd = String.raw`"C:\Program Files\Ollama\ollama.exe" runner --model C:\Users\me\.ollama\models\blobs\sha256-` + BLOB;
  assert.deepEqual(classifyLLM(cmd, resolvers), { runtime: 'ollama', model: 'llama3.1:8b', hint: null });
});

test('classifyLLM: standalone llama.cpp on an Ollama blob stays llama.cpp', () => {
  const cmd = `/app/llama-server -m /usr/share/ollama/.ollama/models/blobs/sha256-${BLOB} --port 8080`;
  assert.deepEqual(classifyLLM(cmd, resolvers), { runtime: 'llamacpp', model: 'llama3.1:8b', hint: null });
  assert.deepEqual(classifyLLM(cmd), {
    runtime: 'llamacpp', model: `sha256:${BLOB.slice(0, 12)}`, hint: 'ollama_manifests',
  });
});

test('classifyLLM: llama.cpp on an unresolved blob prefers --alias', () => {
  const cmd = `/app/llama-server -m /data/blobs/sha256-${BLOB} --alias qwen-local`;
  assert.deepEqual(classifyLLM(cmd), { runtime: 'llamacpp', model: 'qwen-local', hint: null });
});

test('classifyLLM: llama.cpp on a Hugging Face cache blob uses the repo', () => {
  const cmd = `/app/llama-server -m /root/.cache/huggingface/hub/models--unsloth--Qwen3-8B-GGUF/blobs/${BLOB}`;
  assert.deepEqual(classifyLLM(cmd), { runtime: 'llamacpp', model: 'unsloth/Qwen3-8B-GGUF', hint: null });
});

test('classifyLLM: llama.cpp on an anonymous blob flags it', () => {
  assert.deepEqual(classifyLLM(`/app/llama-server -m /data/${BLOB}`), {
    runtime: 'llamacpp', model: `sha256:${BLOB.slice(0, 12)}`, hint: 'blob',
  });
});

test('classifyLLM: llama.cpp -m keeps the file basename', () => {
  assert.deepEqual(classifyLLM('/app/llama-server -m /models/qwen3-8b-Q4_K_M.gguf --port 8080'), {
    runtime: 'llamacpp', model: 'qwen3-8b-Q4_K_M.gguf', hint: null,
  });
});

test('classifyLLM: llama.cpp -hf surfaces the Hugging Face repo', () => {
  const cmd = '/app/llama-server -hf unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q5_K_M --port 8080 --alias qwen3-coder-30b';
  assert.deepEqual(classifyLLM(cmd), {
    runtime: 'llamacpp', model: 'Qwen3-Coder-30B-A3B-Instruct-GGUF:Q5_K_M', hint: null,
  });
});

test('classifyLLM: llama.cpp --alias used when no model flag', () => {
  assert.deepEqual(classifyLLM('/app/llama-server --alias my-model --port 8080'), {
    runtime: 'llamacpp', model: 'my-model', hint: null,
  });
});

test('classifyLLM: llama.cpp with no model at all flags it', () => {
  assert.deepEqual(classifyLLM('/app/llama-server --port 8080'), { runtime: 'llamacpp', model: null, hint: 'no_model' });
});

test('classifyLLM: llama-cpp-python server', () => {
  assert.deepEqual(classifyLLM('python3 -m llama_cpp.server --model /models/mistral-7b.Q4_K_M.gguf'), {
    runtime: 'llamacpp', model: 'mistral-7b.Q4_K_M.gguf', hint: null,
  });
});

test('classifyLLM: vllm serve with a positional model', () => {
  assert.deepEqual(classifyLLM('/usr/bin/python3 /usr/local/bin/vllm serve Qwen/Qwen3-8B --port 8000'), {
    runtime: 'vllm', model: 'Qwen/Qwen3-8B', hint: null,
  });
});

test('classifyLLM: legacy vllm entrypoint with --model', () => {
  const cmd = 'python -m vllm.entrypoints.openai.api_server --model meta-llama/Llama-3-8B-Instruct';
  assert.deepEqual(classifyLLM(cmd), { runtime: 'vllm', model: 'meta-llama/Llama-3-8B-Instruct', hint: null });
});

test('classifyLLM: a script merely named after ollama is not ollama', () => {
  assert.deepEqual(classifyLLM('python3 /opt/tools/ollama_proxy.py'), { runtime: null, model: null, hint: null });
});

test('classifyLLM: null command yields empty result', () => {
  assert.deepEqual(classifyLLM(null), { runtime: null, model: null, hint: null });
});
