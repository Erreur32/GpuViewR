import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeatures } from './config.js';

test('parseFeatures: parses canonical CSV', () => {
  assert.deepEqual(parseFeatures('gpu,system,temps,processes'), {
    gpu: true, system: true, temps: true, processes: true,
  });
});

test('parseFeatures: handles whitespace and case', () => {
  assert.deepEqual(parseFeatures(' GPU , System ,TEMPS'), {
    gpu: true, system: true, temps: true, processes: false,
  });
});

test('parseFeatures: empty string yields all-false', () => {
  assert.deepEqual(parseFeatures(''), {
    gpu: false, system: false, temps: false, processes: false,
  });
});

test('parseFeatures: unknown items are ignored', () => {
  assert.deepEqual(parseFeatures('gpu,floppy,system'), {
    gpu: true, system: true, temps: false, processes: false,
  });
});

test('parseFeatures: gpu-only minimal', () => {
  assert.deepEqual(parseFeatures('gpu'), {
    gpu: true, system: false, temps: false, processes: false,
  });
});
