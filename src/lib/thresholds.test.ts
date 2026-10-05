import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS, gpuKey, readBrowserThresholds, resolveThresholds } from './thresholds.js';

test('resolveThresholds: no override uses the global set, null means no line', () => {
  assert.deepEqual(resolveThresholds({ util: 95, pow: null }, undefined), { util: 95 });
});

test('resolveThresholds: a GPU value or null overrides, a missing metric inherits', () => {
  const global = { util: 95, temp: 83, pow: 350 };
  assert.deepEqual(resolveThresholds(global, { pow: 200, temp: null }), { util: 95, pow: 200 });
});

test('resolveThresholds: a GPU can draw a line the global set leaves off', () => {
  assert.deepEqual(resolveThresholds({ fan: null }, { fan: 70 }), { fan: 70 });
});

test('resolveThresholds: an inherited line is capped at the hardware limit', () => {
  const global = { temp: 83, pow: 350 };
  assert.deepEqual(resolveThresholds(global, undefined, { pow: 200, temp: 95 }), { temp: 83, pow: 200 });
});

test('resolveThresholds: a GPU override ignores the hardware limit, null stays off', () => {
  assert.deepEqual(resolveThresholds({ pow: null }, { temp: 99 }, { pow: 200, temp: 95 }), { temp: 99 });
});

test('resolveThresholds: unknown or 0 limits change nothing', () => {
  assert.deepEqual(resolveThresholds({ pow: 350 }, undefined, { pow: 0, temp: null }), { pow: 350 });
});

test('gpuKey: host id and index', () => {
  assert.equal(gpuKey('local', 0), 'local:0');
});

test('readBrowserThresholds: defaults when nothing or garbage is stored', () => {
  assert.deepEqual(readBrowserThresholds(null), DEFAULT_THRESHOLDS);
  assert.deepEqual(readBrowserThresholds('not json'), DEFAULT_THRESHOLDS);
});

test('readBrowserThresholds: a cleared field becomes null (no line)', () => {
  assert.deepEqual(readBrowserThresholds('{"util":90,"pow":250}'), { util: 90, temp: null, pow: 250, mem: null, fan: null });
});
