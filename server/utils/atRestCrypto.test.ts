import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from './atRestCrypto.js';

test('encryptSecret/decryptSecret: round-trips a plaintext secret', () => {
  const enc = encryptSecret('super-secret-mqtt-password');
  assert.ok(enc.startsWith('gvr1:'));
  assert.notEqual(enc, 'super-secret-mqtt-password');
  assert.equal(decryptSecret(enc), 'super-secret-mqtt-password');
});

test('encryptSecret/decryptSecret: empty string stays empty', () => {
  assert.equal(encryptSecret(''), '');
  assert.equal(decryptSecret(''), '');
});

test('decryptSecret: legacy plaintext (no gvr1: prefix) passes through unchanged', () => {
  assert.equal(decryptSecret('an-old-plaintext-token'), 'an-old-plaintext-token');
});

test('decryptSecret: two encryptions of the same secret produce different ciphertext (random IV)', () => {
  const a = encryptSecret('same-value');
  const b = encryptSecret('same-value');
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a), 'same-value');
  assert.equal(decryptSecret(b), 'same-value');
});

test('decryptSecret: malformed encrypted value fails closed to empty string, does not throw', () => {
  assert.doesNotThrow(() => decryptSecret('gvr1:not-valid-base64-parts'));
  assert.equal(decryptSecret('gvr1:onlyonepart'), '');
});
