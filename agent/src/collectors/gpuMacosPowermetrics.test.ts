import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlistDocument } from './plist.js';
import { __test } from './gpuMacosPowermetrics.js';

const { extractMacGpuFields, splitPlistDocs } = __test;

// Synthetic fixtures reconstructed from public documentation of
// `powermetrics -f plist` (cf. Docs/MACOS_AGENT.md §2.1) — not a real
// captured sample. Two plausible schema shapes are covered: the
// snake_case one (freq_hz/idle_ratio/gpu_energy under nested dicts) and
// the human-readable-label one (spaces-in-keys, mirroring the text
// output). extractMacGpuFields is written to tolerate either.

const SNAKE_CASE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>elapsed_ns</key>
  <integer>1000162000</integer>
  <key>GPU</key>
  <array>
    <dict>
      <key>freq_hz</key>
      <real>1278000000.000000</real>
      <key>idle_ratio</key>
      <real>0.234500</real>
    </dict>
  </array>
  <key>processor</key>
  <dict>
    <key>gpu_energy</key>
    <integer>856</integer>
  </dict>
</dict>
</plist>`;

const HUMAN_LABEL_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>gpu_power</key>
  <dict>
    <key>GPU HW active frequency</key>
    <real>1278.000000</real>
    <key>GPU active residency</key>
    <real>61.340000</real>
    <key>GPU Power</key>
    <integer>1856</integer>
    <key>GPU die temperature</key>
    <real>42.500000</real>
  </dict>
</dict>
</plist>`;

const NO_TEMP_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>elapsed_ns</key>
  <integer>1000000000</integer>
  <key>GPU</key>
  <array>
    <dict>
      <key>freq_hz</key>
      <real>600000000.000000</real>
      <key>idle_ratio</key>
      <real>0.900000</real>
    </dict>
  </array>
</dict>
</plist>`;

test('extractMacGpuFields: snake_case schema (energy-derived power)', () => {
  const root = parsePlistDocument(SNAKE_CASE_PLIST);
  const fields = extractMacGpuFields(root);
  assert.equal(fields.freqMhz, 1278);
  assert.equal(fields.utilization, Math.round((1 - 0.2345) * 100));
  assert.ok(fields.powerMw !== null && fields.powerMw > 0);
  assert.equal(fields.tempC, null);
});

test('extractMacGpuFields: human-readable-label schema (direct power + temp)', () => {
  const root = parsePlistDocument(HUMAN_LABEL_PLIST);
  const fields = extractMacGpuFields(root);
  assert.equal(fields.freqMhz, 1278);
  assert.equal(fields.utilization, 61);
  assert.equal(fields.powerMw, 1856);
  assert.equal(fields.tempC, 42.5);
});

test('extractMacGpuFields: M1-style fixture with no temperature key → null (not 0)', () => {
  const root = parsePlistDocument(NO_TEMP_PLIST);
  const fields = extractMacGpuFields(root);
  assert.equal(fields.tempC, null);
  assert.equal(fields.utilization, 10);
});

test('splitPlistDocs: single doc terminated by NUL', () => {
  const buf = Buffer.concat([Buffer.from('<plist>a</plist>'), Buffer.from([0])]);
  const { docs, rest } = splitPlistDocs(buf);
  assert.deepEqual(docs, ['<plist>a</plist>']);
  assert.equal(rest.length, 0);
});

test('splitPlistDocs: partial trailing doc is held back in `rest`', () => {
  const buf = Buffer.concat([
    Buffer.from('<plist>a</plist>'),
    Buffer.from([0]),
    Buffer.from('<plist>partial'),
  ]);
  const { docs, rest } = splitPlistDocs(buf);
  assert.deepEqual(docs, ['<plist>a</plist>']);
  assert.equal(rest.toString('utf8'), '<plist>partial');
});

test('splitPlistDocs: multiple docs in one chunk', () => {
  const buf = Buffer.from('<a/>\x00<b/>\x00<c/>');
  const { docs, rest } = splitPlistDocs(buf);
  assert.deepEqual(docs, ['<a/>', '<b/>']);
  assert.equal(rest.toString('utf8'), '<c/>');
});
