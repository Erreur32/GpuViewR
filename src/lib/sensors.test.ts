import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sensorMissing } from './sensors.js';

test('sensorMissing: fan and utilization only when null', () => {
  assert.equal(sensorMissing('fan', { fan_speed: null }), true);
  assert.equal(sensorMissing('fan', { fan_speed: 0 }), false); // stopped fan is a reading
  assert.equal(sensorMissing('utilization', { utilization: 0 }), false);
  assert.equal(sensorMissing('utilization', { utilization: null }), true);
});

test('sensorMissing: temperature and power are missing at 0 (Windows PDH, macOS)', () => {
  assert.equal(sensorMissing('temperature', { temperature: 0 }), true);
  assert.equal(sensorMissing('temperature', { temperature: 37 }), false);
  assert.equal(sensorMissing('power', { power: 0 }), true);
  assert.equal(sensorMissing('power', { power: 11.22 }), false);
});

test('sensorMissing: no sample at all', () => {
  assert.equal(sensorMissing('power', undefined), true);
});
