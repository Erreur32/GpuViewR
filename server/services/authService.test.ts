import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { _setDatabaseForTests, closeDatabase } from '../database/connection.js';
import { UserRepository } from '../database/models/User.js';
import { authService, canRegister, PasswordChangeError } from './authService.js';

before(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDatabaseForTests(db);
});

after(() => {
  closeDatabase();
});

beforeEach(() => {
  for (const u of UserRepository.findAll()) UserRepository.delete(u.id);
});

test('register: first user becomes admin', async () => {
  const { user } = await authService.register('alice', 'password123');
  assert.equal(user.role, 'admin');
});

test('register: second user (caller not admin) is rejected once an admin exists', async () => {
  await authService.register('alice', 'password123');
  await assert.rejects(
    () => authService.register('mallory', 'password123'),
    /Registration is closed/,
  );
});

test('register: an admin caller can create further accounts, as plain users', async () => {
  await authService.register('alice', 'password123');
  const { user } = await authService.register('bob', 'password123', { callerIsAdmin: true });
  assert.equal(user.role, 'user');
});

test('register: concurrent bootstrap requests only ever produce ONE admin', async () => {
  // Regression test for a TOCTOU race: two concurrent unauthenticated
  // registrations both reaching the count()===0 bootstrap window used
  // to both win and both get promoted to 'admin'. authService.register
  // now serializes internally, so only the first to actually run
  // becomes admin — the other correctly loses the race and is either
  // rejected (registration now closed) or created as a plain user,
  // but never a second admin.
  const results = await Promise.allSettled([
    authService.register('racer-a', 'password123'),
    authService.register('racer-b', 'password123'),
  ]);

  const admins = UserRepository.findAll().filter((u) => u.role === 'admin');
  assert.equal(admins.length, 1, `expected exactly 1 admin, got ${admins.length}`);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.ok(fulfilled.length >= 1, 'at least the winning racer should succeed');
});

test('canRegister: open for the zero-user bootstrap case, regardless of caller', () => {
  assert.equal(canRegister(0, false), true);
  assert.equal(canRegister(0, true), true);
});

test('canRegister: closed once a user exists, unless the caller is an admin', () => {
  assert.equal(canRegister(1, false), false);
  assert.equal(canRegister(5, false), false);
  assert.equal(canRegister(1, true), true);
});

test('changePassword: right current password, new one works for login', async () => {
  const { user } = await authService.register('pwuser', 'old-password-1', { callerIsAdmin: false });
  const token = await authService.changePassword(user.id, 'old-password-1', 'new-password-2');
  assert.ok(authService.verifyToken(token));
  await assert.rejects(authService.login('pwuser', 'old-password-1'));
  assert.ok((await authService.login('pwuser', 'new-password-2')).token);
});

test('changePassword: wrong current, too short, unchanged or unknown account are refused', async () => {
  const { user } = await authService.register('pwuser', 'old-password-1', { callerIsAdmin: false });
  const status = async (p: Promise<unknown>) => {
    try { await p; return 0; } catch (e) { return e instanceof PasswordChangeError ? e.status : -1; }
  };
  assert.equal(await status(authService.changePassword(user.id, 'wrong-password', 'new-password-2')), 403);
  assert.equal(await status(authService.changePassword(user.id, 'old-password-1', 'short')), 400);
  assert.equal(await status(authService.changePassword(user.id, 'old-password-1', 'old-password-1')), 400);
  assert.equal(await status(authService.changePassword(9999, 'old-password-1', 'new-password-2')), 404);
  assert.ok((await authService.login('pwuser', 'old-password-1')).token, 'unchanged after refusals');
});
