import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inOwnPidNamespace, mergeQueryPids, parseBusUuidMap, parsePmon, parseQueryPids, type AgentGpuProcess } from './processes.js';

const PMON = `# gpu         pid   type     sm    mem    enc    dec    jpg    ofa    command
# Idx           #    C/G      %      %      %      %      %      %    name
    0       1607     G      -      -      -      -      -      -    Xorg
    0       5347   C+G      -      -      -      -      -      -    anydesk
    0       9001     C     42      7      -      -      -      -    llama-server
    0       9002   G+C      3      1      -      -      -      -    firefox
`;

test('parsePmon: reads type and SM% per pid', () => {
  const m = parsePmon(PMON);
  assert.deepEqual(m.get(1607), { type: 'G', gpuPct: null });
  assert.deepEqual(m.get(9001), { type: 'C', gpuPct: 42 });
  assert.deepEqual(m.get(9002), { type: 'G+C', gpuPct: 3 });
});

test('parsePmon: normalises the "C+G" spelling of recent drivers to G+C', () => {
  assert.deepEqual(parsePmon(PMON).get(5347), { type: 'G+C', gpuPct: null });
});

const QUERY_PIDS = `
==============NVSMI LOG==============

Timestamp                                 : Thu Oct  2 10:00:00 2026
Driver Version                            : 570.86.15
CUDA Version                              : 12.8

Attached GPUs                             : 2
GPU 00000000:01:00.0
    Processes
        GPU instance ID                   : N/A
        Compute instance ID               : N/A
        Process ID                        : 1607
            Type                          : G
            Name                          : /usr/lib/xorg/Xorg
            Used GPU Memory               : 245 MiB
        GPU instance ID                   : N/A
        Compute instance ID               : N/A
        Process ID                        : 5347
            Type                          : C+G
            Name                          : /usr/bin/anydesk
            Used GPU Memory               : 5 MiB

GPU 00000000:02:00.0
    Processes                             : None
`;

test('parseQueryPids: lists graphics and compute clients per bus id', () => {
  assert.deepEqual(parseQueryPids(QUERY_PIDS), [
    { busId: '00000000:01:00.0', pid: 1607, type: 'G', name: '/usr/lib/xorg/Xorg', used_memory: 245 },
    { busId: '00000000:01:00.0', pid: 5347, type: 'G+C', name: '/usr/bin/anydesk', used_memory: 5 },
  ]);
});

test('parseQueryPids: WDDM "Not available" memory becomes 0', () => {
  const out = 'GPU 00000000:01:00.0\n    Processes\n        Process ID : 42\n            Type : G\n            Name : C:\\\\Windows\\\\explorer.exe\n            Used GPU Memory : Not available in WDDM driver model\n';
  assert.equal(parseQueryPids(out)[0].used_memory, 0);
});

test('parseBusUuidMap: maps normalised bus id to uuid', () => {
  const m = parseBusUuidMap('00000000:01:00.0, GPU-aaa\n00000000:02:00.0, GPU-bbb\n');
  assert.equal(m.get('00000000:01:00.0'), 'GPU-aaa');
  assert.equal(m.get('00000000:02:00.0'), 'GPU-bbb');
});

test('mergeQueryPids: adds graphics-only pids, keeps compute-apps rows, drops unknown GPUs', () => {
  const procs: AgentGpuProcess[] = [{
    pid: 5347, process_name: 'anydesk', gpu_uuid: 'GPU-aaa', used_memory: 5,
    type: null, command: null, cpu_pct: null, gpu_pct: null,
  }];
  const listed = [
    ...parseQueryPids(QUERY_PIDS),
    { busId: '00000000:09:00.0', pid: 777, type: 'G' as const, name: 'ghost', used_memory: 1 },
  ];
  mergeQueryPids(procs, listed, new Map([['00000000:01:00.0', 'GPU-aaa']]), '/nonexistent');
  assert.deepEqual(procs.map((p) => [p.pid, p.process_name, p.gpu_uuid, p.used_memory]), [
    [5347, 'anydesk', 'GPU-aaa', 5],
    [1607, 'Xorg', 'GPU-aaa', 245],
  ]);
});

async function fakeProc(nspid: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gv-pidns-'));
  await mkdir(join(root, 'self'));
  await writeFile(join(root, 'self', 'status'), `Name:\tnode\n${nspid === null ? '' : `NSpid:\t${nspid}\n`}Uid:\t0\n`);
  return root;
}

test('inOwnPidNamespace: Docker agent without pid: host (host pid + container pid)', async () => {
  assert.equal(inOwnPidNamespace(await fakeProc('1440089\t9796')), true);
});

test('inOwnPidNamespace: pid: host, systemd, old kernel or no /host/proc', async () => {
  assert.equal(inOwnPidNamespace(await fakeProc('1440170')), false);
  assert.equal(inOwnPidNamespace(await fakeProc(null)), false);
  assert.equal(inOwnPidNamespace('/nonexistent-gv-proc'), false);
});
