import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheTtlMs } from './updateService.js';

const DAY = 24 * 3_600_000;

test('cacheTtlMs: up to date or behind keeps the configured frequency', () => {
  assert.equal(cacheTtlMs({ currentVersion: '0.11.9', latestVersion: '0.11.9' }, 24), DAY);
  assert.equal(cacheTtlMs({ currentVersion: '0.11.8', latestVersion: '0.11.9' }, 24), DAY);
  assert.equal(cacheTtlMs({ currentVersion: '0.11.9', latestVersion: null }, 24), DAY);
});

test('cacheTtlMs: running ahead of the newest tag re-checks after 10 min', () => {
  // Hub pulled :latest at merge time, before the v0.11.9 tag was pushed.
  assert.equal(cacheTtlMs({ currentVersion: '0.11.9', latestVersion: '0.11.8' }, 24), 10 * 60_000);
});
