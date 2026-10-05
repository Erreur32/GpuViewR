import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostPowerMax, powerScale, tempScale } from './gaugeScale.js';

test('powerScale: the power cap is the full scale', () => {
  assert.deepEqual(powerScale(31.5, 200), { max: 200, warn: 160, danger: 190 });
});

test('powerScale: a draw above the cap stretches the scale', () => {
  assert.equal(powerScale(212.4, 200).max, 213);
});

test('powerScale: no cap keeps the old guess', () => {
  assert.deepEqual(powerScale(400, null), { max: 560, warn: 250, danger: 350 });
  assert.deepEqual(powerScale(10, undefined), { max: 300, warn: 250, danger: 350 });
});

test('tempScale: bands follow the throttle temperature', () => {
  assert.deepEqual(tempScale(95), { max: 100, warn: 80, danger: 90 });
  assert.deepEqual(tempScale(110), { max: 110, warn: 95, danger: 105 });
  assert.deepEqual(tempScale(0), { max: 100, warn: 75, danger: 85 });
});

test('hostPowerMax: sums caps, 300 W for cards without one', () => {
  assert.equal(hostPowerMax([{ power: 30, power_limit: 200 }, { power: 50, power_limit: 450 }]), 650);
  assert.equal(hostPowerMax([{ power: 30, power_limit: 200 }, { power: 50 }]), 500);
  assert.equal(hostPowerMax([{ power: 400 }]), 560);
});
