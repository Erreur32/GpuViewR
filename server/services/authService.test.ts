import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { _setDatabaseForTests, closeDatabase } from '../database/connection.js';
import { UserRepository } from '../database/models/User.js';
import { authService, canRegister, AccountChangeError, sessionEvents } from './authService.js';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

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
    try { await p; return 0; } catch (e) { return e instanceof AccountChangeError ? e.status : -1; }
  };
  assert.equal(await status(authService.changePassword(user.id, 'wrong-password', 'new-password-2')), 403);
  assert.equal(await status(authService.changePassword(user.id, 'old-password-1', 'short')), 400);
  assert.equal(await status(authService.changePassword(user.id, 'old-password-1', 'old-password-1')), 400);
  assert.equal(await status(authService.changePassword(9999, 'old-password-1', 'new-password-2')), 404);
  assert.ok((await authService.login('pwuser', 'old-password-1')).token, 'unchanged after refusals');
});

test('changeUsername: renamed account logs in under the new name, token carries it', async () => {
  const { user } = await authService.register('olduser', 'password-123', { callerIsAdmin: false });
  const r = await authService.changeUsername(user.id, 'password-123', '  newuser  ');
  assert.equal(r.user.username, 'newuser');
  assert.equal(authService.verifyToken(r.token)?.username, 'newuser');
  await assert.rejects(authService.login('olduser', 'password-123'));
  assert.equal((await authService.login('newuser', 'password-123')).user.id, user.id);
});

test('changeUsername: wrong password, too short, unchanged, taken or unknown account are refused', async () => {
  const { user } = await authService.register('olduser', 'password-123', { callerIsAdmin: false });
  await authService.register('taken', 'password-123', { callerIsAdmin: true });
  const status = async (p: Promise<unknown>) => {
    try { await p; return 0; } catch (e) { return e instanceof AccountChangeError ? e.status : -1; }
  };
  assert.equal(await status(authService.changeUsername(user.id, 'wrong-password', 'newuser')), 403);
  assert.equal(await status(authService.changeUsername(user.id, 'password-123', 'ab')), 400);
  assert.equal(await status(authService.changeUsername(user.id, 'password-123', 'olduser')), 400);
  assert.equal(await status(authService.changeUsername(user.id, 'password-123', 'evil\n[INFO] forged')), 400);
  assert.equal(await status(authService.changeUsername(user.id, 'password-123', 'taken')), 409);
  assert.equal(await status(authService.changeUsername(9999, 'password-123', 'newuser')), 404);
  assert.equal(UserRepository.findById(user.id)?.username, 'olduser', 'unchanged after refusals');
});

test('verifyToken: a password change revokes older tokens, a rename does not', async () => {
  const { user, token: before } = await authService.register('sess', 'password-123', { callerIsAdmin: false });
  const { token: renamed } = await authService.changeUsername(user.id, 'password-123', 'sess2');
  assert.equal(authService.verifyToken(before)?.username, 'sess2', 'rename keeps sessions, name read from the row');
  const after = await authService.changePassword(user.id, 'password-123', 'password-456');
  assert.equal(authService.verifyToken(before), null);
  assert.equal(authService.verifyToken(renamed), null);
  assert.equal(authService.verifyToken(after)?.sub, user.id);
});

test('verifyToken: legacy token without ver is accepted until the first password change; deleted account is refused', async () => {
  const { user } = await authService.register('legacy', 'password-123', { callerIsAdmin: false });
  const legacy = jwt.sign({ sub: user.id, username: 'legacy', role: user.role }, config.jwtSecret, { expiresIn: '1h' });
  assert.equal(authService.verifyToken(legacy)?.sub, user.id);
  const fresh = await authService.changePassword(user.id, 'password-123', 'password-456');
  assert.equal(authService.verifyToken(legacy), null);
  UserRepository.delete(user.id);
  assert.equal(authService.verifyToken(fresh), null);
});

test('sessionEvents: a password change emits revoked with the user id, a rename does not', async () => {
  const { user } = await authService.register('evt', 'password-123', { callerIsAdmin: false });
  const seen: number[] = [];
  const onRevoked = (id: number) => seen.push(id);
  sessionEvents.on('revoked', onRevoked);
  try {
    await authService.changeUsername(user.id, 'password-123', 'evt2');
    assert.deepEqual(seen, []);
    await authService.changePassword(user.id, 'password-123', 'password-456');
    assert.deepEqual(seen, [user.id]);
  } finally {
    sessionEvents.off('revoked', onRevoked);
  }
});
