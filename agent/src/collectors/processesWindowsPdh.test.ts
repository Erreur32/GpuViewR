import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAdaptersToUuids, parsePdhProcLine, pdhDisplayName, pdhType } from './processesWindowsPdh.js';

const DGPU = 'luid_0x00000000_0x0000D1B5_phys_0';
const IGPU = 'luid_0x00000000_0x0000C9A5_phys_0';

test('parsePdhProcLine: keeps well-formed rows, drops malformed ones', () => {
  const line = JSON.stringify({
    procs: [
      { pid: 4242, key: DGPU, util: 37, ded_mb: 5120, g: false, c: true, name: 'ollama', path: String.raw`C:\Program Files\Ollama\ollama.exe`, cpu_s: 12.5, cmd: 'ollama serve' },
      { pid: 'nope', key: DGPU },
      { pid: 7 },
      null,
    ],
  });
  const p = parsePdhProcLine(line);
  assert.equal(p?.procs.length, 1);
  assert.equal(p?.procs[0].pid, 4242);
  assert.equal(p?.err, undefined);
});

test('parsePdhProcLine: surfaces err, rejects non-JSON', () => {
  assert.deepEqual(parsePdhProcLine('{"procs":[],"err":"no_counters"}'), { procs: [], err: 'no_counters' });
  assert.equal(parsePdhProcLine('WARNING: something'), null);
});

test('pdhDisplayName: Windows path basename, then ProcessName.exe', () => {
  assert.equal(pdhDisplayName({ path: String.raw`C:\Windows\System32\dwm.exe`, name: 'dwm' }), 'dwm.exe');
  assert.equal(pdhDisplayName({ path: null, name: 'csrss' }), 'csrss.exe');
  assert.equal(pdhDisplayName({ path: null, name: null }), 'unknown');
});

test('pdhType: graphics, compute, both, idle', () => {
  assert.equal(pdhType({ g: true, c: false }), 'G');
  assert.equal(pdhType({ g: false, c: true }), 'C');
  assert.equal(pdhType({ g: true, c: true }), 'G+C');
  assert.equal(pdhType({ g: false, c: false }), null);
});

test('matchAdaptersToUuids: shared pids do not drag the iGPU onto the NVIDIA uuid', () => {
  // dwm (100) and a browser (200) use both adapters; the CUDA app (300)
  // and a game (400) only the dGPU. nvidia-smi lists all four on the RTX.
  const rows = [
    { pid: 100, key: DGPU }, { pid: 100, key: IGPU },
    { pid: 200, key: DGPU }, { pid: 200, key: IGPU },
    { pid: 300, key: DGPU },
    { pid: 400, key: DGPU },
  ];
  const uuidByPid = new Map([[100, 'GPU-rtx'], [200, 'GPU-rtx'], [300, 'GPU-rtx'], [400, 'GPU-rtx']]);
  const m = matchAdaptersToUuids(rows, uuidByPid);
  assert.equal(m.get(DGPU), 'GPU-rtx');
  assert.equal(m.has(IGPU), false);
});

test('matchAdaptersToUuids: two NVIDIA cards map one-to-one', () => {
  const second = 'luid_0x00000000_0x0000E000_phys_0';
  const rows = [{ pid: 1, key: DGPU }, { pid: 2, key: DGPU }, { pid: 3, key: second }];
  const uuidByPid = new Map([[1, 'GPU-a'], [2, 'GPU-a'], [3, 'GPU-b']]);
  const m = matchAdaptersToUuids(rows, uuidByPid);
  assert.equal(m.get(DGPU), 'GPU-a');
  assert.equal(m.get(second), 'GPU-b');
});
