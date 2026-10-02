import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortGpuName } from './gpuName.js';

test('shortGpuName: NVIDIA vendor + brand trimmed', () => {
  assert.equal(shortGpuName('NVIDIA GeForce RTX 4090'), 'RTX 4090');
  assert.equal(shortGpuName('NVIDIA RTX 4500 Ada Generation'), 'RTX 4500 Ada Generation');
  assert.equal(shortGpuName('Tesla T4'), 'T4');
});

test('shortGpuName: AMD vendor + brand trimmed', () => {
  assert.equal(shortGpuName('AMD Radeon RX 7900 XTX'), 'RX 7900 XTX');
  assert.equal(shortGpuName('AMD Radeon Pro W7900'), 'Pro W7900');
  assert.equal(shortGpuName('AMD Instinct MI300X'), 'MI300X');
  assert.equal(shortGpuName('AMD Radeon 8060S Graphics'), '8060S Graphics');
});

test('shortGpuName: keeps the brand when only a generic word would remain', () => {
  assert.equal(shortGpuName('AMD Radeon Graphics'), 'Radeon Graphics');
  assert.equal(shortGpuName('NVIDIA GeForce'), 'GeForce');
});

test('shortGpuName: unknown vendors pass through', () => {
  assert.equal(shortGpuName('Apple M3 Max'), 'Apple M3 Max');
  assert.equal(shortGpuName('Intel Arc A770'), 'Intel Arc A770');
});
