import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChipsetModel, parseMemsizeBytes, parseVmStatPages, computeMemoryUsedMb } from './macosSysctl.js';

test('parseChipsetModel: extracts the "Chipset Model:" line', () => {
  const raw = `Graphics/Displays:

    Apple M2 Max:

      Chipset Model: Apple M2 Max
      Type: GPU
      Bus: Built-In
      Total Number of Cores: 38
`;
  assert.equal(parseChipsetModel(raw), 'Apple M2 Max');
});

test('parseChipsetModel: no match returns null', () => {
  assert.equal(parseChipsetModel('nothing here'), null);
});

test('parseMemsizeBytes: parses decimal byte count', () => {
  assert.equal(parseMemsizeBytes('34359738368\n'), 34359738368);
});

test('parseMemsizeBytes: garbage returns null', () => {
  assert.equal(parseMemsizeBytes('not-a-number'), null);
  assert.equal(parseMemsizeBytes('0'), null);
});

const VM_STAT_FIXTURE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               123456.
Pages active:                              234567.
Pages inactive:                            345678.
Pages speculative:                            1234.
Pages throttled:                                 0.
Pages wired down:                          456789.
Pages purgeable:                              5678.
"Translation faults":                    123456789.
Pages copy-on-write:                       1234567.
Pages zero filled:                        12345678.
Pages reactivated:                           12345.
Pages purged:                                 6789.
File-backed pages:                          234567.
Anonymous pages:                            345678.
Pages stored in compressor:                 456789.
Pages occupied by compressor:               123456.
Decompressions:                              12345.
Compressions:                                23456.
Pageins:                                   1234567.
Pageouts:                                     1234.
Swapins:                                          0.
Swapouts:                                         0.
`;

test('parseVmStatPages: reads page size + labelled counters', () => {
  const { pageSize, pages } = parseVmStatPages(VM_STAT_FIXTURE);
  assert.equal(pageSize, 16384);
  assert.equal(pages['Pages active'], 234567);
  assert.equal(pages['Pages wired down'], 456789);
  assert.equal(pages['Pages occupied by compressor'], 123456);
});

test('computeMemoryUsedMb: sums active+wired+compressed, caps at total', () => {
  const totalMb = 16384; // 16 GiB
  const used = computeMemoryUsedMb(VM_STAT_FIXTURE, totalMb);
  assert.ok(used !== null && used > 0);
  assert.ok((used as number) <= totalMb);
});

test('computeMemoryUsedMb: null total → null', () => {
  assert.equal(computeMemoryUsedMb(VM_STAT_FIXTURE, null), null);
});
