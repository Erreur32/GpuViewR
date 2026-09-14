import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlistDocument } from './plist.js';

test('parsePlistDocument: flat dict with string/integer/real/bool', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>hw_model</key>
  <string>Mac14,7</string>
  <key>elapsed_ns</key>
  <integer>1000162000</integer>
  <key>freq_hz</key>
  <real>1278.5</real>
  <key>is_delta</key>
  <true/>
</dict>
</plist>`;
  const out = parsePlistDocument(xml) as Record<string, unknown>;
  assert.equal(out.hw_model, 'Mac14,7');
  assert.equal(out.elapsed_ns, 1000162000);
  assert.equal(out.freq_hz, 1278.5);
  assert.equal(out.is_delta, true);
});

test('parsePlistDocument: nested dict + array of dicts', () => {
  const xml = `<plist version="1.0">
<dict>
  <key>GPU</key>
  <array>
    <dict>
      <key>freq_hz</key>
      <real>1278.000000</real>
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
  const out = parsePlistDocument(xml) as Record<string, unknown>;
  const gpuArr = out.GPU as Array<Record<string, unknown>>;
  assert.equal(gpuArr.length, 1);
  assert.equal(gpuArr[0].freq_hz, 1278);
  assert.equal(gpuArr[0].idle_ratio, 0.2345);
  assert.equal((out.processor as Record<string, unknown>).gpu_energy, 856);
});

test('parsePlistDocument: decodes XML entities in text', () => {
  const xml = `<plist version="1.0"><dict><key>note</key><string>a &amp; b &lt;c&gt;</string></dict></plist>`;
  const out = parsePlistDocument(xml) as Record<string, unknown>;
  assert.equal(out.note, 'a & b <c>');
});

test('parsePlistDocument: empty dict does not throw', () => {
  const out = parsePlistDocument('<plist version="1.0"><dict></dict></plist>');
  assert.deepEqual(out, {});
});

test('parsePlistDocument: human-readable-style keys with spaces survive as-is', () => {
  const xml = `<plist version="1.0">
<dict>
  <key>GPU Power</key>
  <integer>1856</integer>
  <key>GPU die temperature</key>
  <real>42.500000</real>
</dict>
</plist>`;
  const out = parsePlistDocument(xml) as Record<string, unknown>;
  assert.equal(out['GPU Power'], 1856);
  assert.equal(out['GPU die temperature'], 42.5);
});
