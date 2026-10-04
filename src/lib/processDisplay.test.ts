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

test('residualGpuPct: card minus measured, one unmeasured chat row only', () => {
  const r = (gpu_pct: number | null | undefined, extra: object = {}) => ({ gpu_pct, ...extra });
  const pct = (rows: ReturnType<typeof r>[], card: number | null) => residualGpuPct(rows, card)?.pct ?? null;
  // Ollama ROCm runner (no counter) next to a Vulkan llama.cpp at 20 %.
  assert.equal(pct([r(null), r(20)], 65), 45);
  assert.equal(pct([r(null)], 80), 80);
  assert.equal(pct([r(null), r(90)], 70), 0);
  assert.equal(pct([r(null), r(undefined)], 80), null);
  assert.equal(pct([r(10)], 80), null);
  assert.equal(pct([r(null)], null), null);
  // Chat model + bge-m3 embedding runner, both unmeasured: the chat row gets it.
  const chat = r(null, { llm_runtime: 'ollama', llm_model: 'qwen3-4b-instruct:64k', command: '/usr/lib/ollama/llama-server -c 131072' });
  const embed = r(null, { llm_runtime: 'ollama', llm_model: 'bge-m3:latest', command: '/usr/lib/ollama/llama-server --embedding' });
  assert.deepEqual(residualGpuPct([embed, chat], 55), { row: chat, pct: 55 });
  // Alone on the card, an embedding runner still gets the card value.
  assert.equal(residualGpuPct([embed], 30)?.row, embed);
  // Two chat models without a counter: no guess.
  assert.equal(residualGpuPct([chat, { ...chat }, embed], 55), null);
});
