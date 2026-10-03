import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hiddenProcesses, parseVisibility } from './processVisibility.js';
import type { GpuProcess, ProcessVisibility } from './_processTypes.js';
import type { GpuSample } from './parsers/nvidia.js';

const VIS: ProcessVisibility = { denied_pids: 94, has_ptrace: false, install_mode: 'systemd' };

function card(idx: number, used: number): GpuSample {
  return { gpu_index: idx, memory_used: used } as GpuSample;
}

function proc(used: number): GpuProcess {
  return { pid: 1, process_name: 'x', gpu_uuid: 'u', used_memory: used } as GpuProcess;
}

test('parseVisibility: keeps typed fields, drops the rest', () => {
  assert.deepEqual(
    parseVisibility({ denied_pids: 94.7, has_ptrace: 'yes', install_mode: 'systemd', extra: '<script>' }),
    { denied_pids: 94, has_ptrace: false, install_mode: 'systemd' },
  );
  assert.equal(parseVisibility({ denied_pids: 3, has_ptrace: true, install_mode: '<b>' })?.install_mode, 'unknown');
});

test('parseVisibility: nothing to report', () => {
  assert.equal(parseVisibility(undefined), null);
  assert.equal(parseVisibility('x'), null);
  assert.equal(parseVisibility({ denied_pids: 0 }), null);
  assert.equal(parseVisibility({ denied_pids: Number.NaN }), null);
});

test('hiddenProcesses: jarvis case, Vulkan llama.cpp missing from the list', () => {
  // 40 GiB in use, only the 14 GiB Ollama runner listed.
  const out = hiddenProcesses(VIS, [card(0, 40_960)], [proc(13_377)], 0);
  assert.deepEqual(out, { ...VIS, unaccounted_mib: 27_583 });
});

test('hiddenProcesses: silent when the listed processes explain the VRAM', () => {
  assert.equal(hiddenProcesses(VIS, [card(0, 40_960)], [proc(13_377), proc(26_804)], 0), null);
});

test('hiddenProcesses: only the filtered card counts', () => {
  assert.equal(hiddenProcesses(VIS, [card(0, 500), card(1, 30_000)], [], 0), null);
  assert.equal(hiddenProcesses(VIS, [card(0, 500), card(1, 30_000)], [], 1)?.unaccounted_mib, 30_000);
});

test('hiddenProcesses: no card sample, no warning', () => {
  assert.equal(hiddenProcesses(VIS, [], [], 0), null);
});
