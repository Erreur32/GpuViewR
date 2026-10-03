import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeatures, parseGpuBackend, parseGpuVendor, resolveFeaturesEnv, resolveHostProc } from './config.js';

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
  assert.equal(parseGpuVendor('apple'), 'apple');
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

test('resolveHostProc: explicit HOST_PROC wins', () => {
  assert.equal(resolveHostProc('/custom/proc', 'linux', () => false), '/custom/proc');
});

test('resolveHostProc: docker mount point used when present', () => {
  assert.equal(resolveHostProc(undefined, 'linux', () => true), '/host/proc');
});

test('resolveHostProc: systemd install without /host/proc falls back to /proc', () => {
  assert.equal(resolveHostProc(undefined, 'linux', () => false), '/proc');
});

test('resolveHostProc: empty on Windows', () => {
  assert.equal(resolveHostProc(undefined, 'win32', () => true), '');
});

test('resolveFeaturesEnv: legacy Windows installer default gains processes', () => {
  assert.equal(resolveFeaturesEnv('gpu', 'win32'), 'gpu,processes');
  assert.equal(resolveFeaturesEnv(' GPU ', 'win32'), 'gpu,processes');
});

test('resolveFeaturesEnv: explicit lists and other platforms are untouched', () => {
  assert.equal(resolveFeaturesEnv('gpu', 'linux'), 'gpu');
  assert.equal(resolveFeaturesEnv('gpu,system', 'win32'), 'gpu,system');
  assert.equal(resolveFeaturesEnv(undefined, 'win32'), 'gpu,system,temps,processes');
  assert.equal(resolveFeaturesEnv('', 'linux'), 'gpu,system,temps,processes');
});
