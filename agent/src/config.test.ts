import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeatures, parseGpuBackend, parseGpuVendor } from './config.js';

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

test('parseGpuVendor: explicit values pass through', () => {
  assert.equal(parseGpuVendor('nvidia'), 'nvidia');
  assert.equal(parseGpuVendor('amd'), 'amd');
  assert.equal(parseGpuVendor('auto'), 'auto');
});

test('parseGpuVendor: case + whitespace tolerated', () => {
  assert.equal(parseGpuVendor(' AMD '), 'amd');
  assert.equal(parseGpuVendor('Nvidia'), 'nvidia');
});

test('parseGpuVendor: unknown / undefined falls back to auto', () => {
  assert.equal(parseGpuVendor(undefined), 'auto');
  assert.equal(parseGpuVendor(''), 'auto');
  assert.equal(parseGpuVendor('intel'), 'auto');
});

test('parseGpuBackend: explicit values pass through', () => {
  assert.equal(parseGpuBackend('sysfs'), 'sysfs');
  assert.equal(parseGpuBackend('rocm-smi'), 'rocm-smi');
  assert.equal(parseGpuBackend('auto'), 'auto');
});

test('parseGpuBackend: case + whitespace tolerated', () => {
  assert.equal(parseGpuBackend(' SYSFS '), 'sysfs');
  assert.equal(parseGpuBackend('ROCM-SMI'), 'rocm-smi');
});

test('parseGpuBackend: unknown / undefined falls back to auto', () => {
  assert.equal(parseGpuBackend(undefined), 'auto');
  assert.equal(parseGpuBackend(''), 'auto');
  assert.equal(parseGpuBackend('libdrm'), 'auto');
});
