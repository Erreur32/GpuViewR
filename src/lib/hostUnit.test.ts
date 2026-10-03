import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnitOutdated } from './hostUnit.js';

const caps = (ptrace?: string) => JSON.stringify({ gpu: true, processes: true, ...(ptrace ? { ptrace } : {}) });

test('isUnitOutdated: systemd agent without CAP_SYS_PTRACE', () => {
  assert.equal(isUnitOutdated(caps('missing'), 'systemd'), true);
});

test('isUnitOutdated: granted, declined (--no-ptrace) or not reported', () => {
  assert.equal(isUnitOutdated(caps('granted'), 'systemd'), false);
  assert.equal(isUnitOutdated(caps('declined'), 'systemd'), false);
  assert.equal(isUnitOutdated(caps(), 'systemd'), false);
});

test('isUnitOutdated: only systemd hosts, bad input ignored', () => {
  assert.equal(isUnitOutdated(caps('missing'), 'docker'), false);
  assert.equal(isUnitOutdated(null, 'systemd'), false);
  assert.equal(isUnitOutdated('{not json', 'systemd'), false);
  assert.equal(isUnitOutdated('"missing"', 'systemd'), false);
});
