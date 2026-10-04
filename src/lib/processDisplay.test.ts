import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gpuMemoryMib, isEmbeddingProcess, residualGpuPct } from '../components/dashboard/ProcessExtras.js';

test('isEmbeddingProcess: runner flags and model names', () => {
  const ollama = '/usr/lib/ollama/llama-server --model /root/.ollama/models/blobs/sha256-dae --port 37483 --embedding -b 2048';
  assert.equal(isEmbeddingProcess({ llm_runtime: 'ollama', llm_model: 'bge-m3:latest', command: ollama }), true);
  assert.equal(isEmbeddingProcess({ llm_runtime: 'llamacpp', llm_model: 'x.gguf', command: '/app/llama-server -m x.gguf --embeddings' }), true);
  assert.equal(isEmbeddingProcess({ llm_runtime: 'vllm', llm_model: 'intfloat/e5', command: 'vllm serve intfloat/e5 --task embed' }), true);
  assert.equal(isEmbeddingProcess({ llm_runtime: 'ollama', llm_model: 'nomic-embed-text:latest', command: null }), true);
  assert.equal(isEmbeddingProcess({ llm_runtime: 'ollama', llm_model: 'hermes3:8b', command: '/usr/lib/ollama/llama-server --model x -c 131072' }), false);
  // Not an LLM process: never flagged, whatever the command says.
  assert.equal(isEmbeddingProcess({ llm_runtime: null, llm_model: null, command: 'python embed.py --embedding' }), false);
});

test('gpuMemoryMib: VRAM + GTT', () => {
  assert.equal(gpuMemoryMib({ used_memory: 0, gtt_memory: 830 }), 830);
  assert.equal(gpuMemoryMib({ used_memory: 17, gtt_memory: 13_989 }), 14_006);
  assert.equal(gpuMemoryMib({ used_memory: 4416 }), 4416);
});

test('residualGpuPct: card minus measured, only for a single unknown row', () => {
  // Ollama ROCm runner (no counter) next to a Vulkan llama.cpp at 20 %.
  assert.equal(residualGpuPct([{ gpu_pct: null }, { gpu_pct: 20 }], 65), 45);
  assert.equal(residualGpuPct([{ gpu_pct: null }], 80), 80);
  assert.equal(residualGpuPct([{ gpu_pct: null }, { gpu_pct: 90 }], 70), 0);
  assert.equal(residualGpuPct([{ gpu_pct: null }, { gpu_pct: undefined }], 80), null);
  assert.equal(residualGpuPct([{ gpu_pct: 10 }], 80), null);
  assert.equal(residualGpuPct([{ gpu_pct: null }], null), null);
});
