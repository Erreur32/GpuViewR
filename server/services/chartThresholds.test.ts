import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { _setDatabaseForTests, closeDatabase } from '../database/connection.js';
import { chartThresholds, ChartThresholdsError, parseChartThresholds } from './chartThresholds.js';

before(() => {
  _setDatabaseForTests(new Database(':memory:'));
});

after(() => {
  closeDatabase();
});

test('parseChartThresholds: numbers and null kept, empty GPU entries dropped', () => {
  const doc = parseChartThresholds({
    global: { util: 95, pow: null },
    gpus: { 'local:0': { pow: 200, temp: null }, 'jarvis:1': {} },
  });
  assert.deepEqual(doc, {
    global: { util: 95, pow: null },
    gpus: { 'local:0': { pow: 200, temp: null } },
  });
});

test('parseChartThresholds: missing global stays null (never saved)', () => {
  assert.deepEqual(parseChartThresholds({}), { global: null, gpus: {} });
});

test('parseChartThresholds: host ids with ":" keep the index after the last one', () => {
  const doc = parseChartThresholds({ gpus: { 'a:b:3': { util: 50 } } });
  assert.deepEqual(Object.keys(doc.gpus), ['a:b:3']);
});

test('parseChartThresholds: rejects bad input with a readable reason', () => {
  const bad: unknown[] = [
    null,
    [],
    { global: { volts: 1 } },
    { global: { util: -1 } },
    { global: { util: 1e9 } },
    { global: { util: '95' } },
    { gpus: { 'nocolon': { util: 1 } } },
    { gpus: { ':0': { util: 1 } } },
    { gpus: { 'h:64': { util: 1 } } },
    { gpus: { 'h:x': { util: 1 } } },
    { gpus: { 'h\u0007:0': { util: 1 } } },
    { gpus: [] },
  ];
  for (const b of bad) assert.throws(() => parseChartThresholds(b), ChartThresholdsError, JSON.stringify(b));
});

test('parseChartThresholds: caps the number of GPU entries', () => {
  const gpus: Record<string, { util: number }> = {};
  for (let i = 0; i < 257; i++) gpus[`h${i}:0`] = { util: 1 };
  assert.throws(() => parseChartThresholds({ gpus }), ChartThresholdsError);
});

test('chartThresholds: round-trips through app_config, default when nothing saved', () => {
  assert.deepEqual(chartThresholds.get(), { global: null, gpus: {} });
  chartThresholds.set({ global: { util: 90 }, gpus: { 'local:0': { pow: 200 } } });
  assert.deepEqual(chartThresholds.get(), { global: { util: 90 }, gpus: { 'local:0': { pow: 200 } } });
});
