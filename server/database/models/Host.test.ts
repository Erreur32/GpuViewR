import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { _setDatabaseForTests, closeDatabase } from '../connection.js';
import { HostsRepo, LOCAL_HOST_ID } from './Host.js';

before(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDatabaseForTests(db);
});

after(() => {
  closeDatabase();
});

test('HostsRepo: seedLocalIfMissing produces the local host row', () => {
  const local = HostsRepo.findById(LOCAL_HOST_ID);
  assert.ok(local, 'local row missing');
  assert.equal(local!.kind, 'local');
  assert.equal(local!.status, 'online');
});

test('HostsRepo: insert/findById round-trip with token hash', () => {
  const inserted = HostsRepo.insert({
    id: 'unit-test-1',
    label: 'rtx-rig',
    kind: 'agent',
    token_hash: '$2a$10$fakehash',
    status: 'pending',
  });
  assert.equal(inserted.id, 'unit-test-1');
  assert.equal(inserted.kind, 'agent');
  assert.equal(inserted.status, 'pending');
  assert.equal(inserted.token_hash, '$2a$10$fakehash');

  const found = HostsRepo.findById('unit-test-1');
  assert.ok(found);
  assert.equal(found!.label, 'rtx-rig');

  HostsRepo.delete('unit-test-1');
});

test('HostsRepo: list returns all rows ordered by enrolled_at', () => {
  HostsRepo.insert({ id: 'a', label: 'a', kind: 'agent', token_hash: 'h' });
  HostsRepo.insert({ id: 'b', label: 'b', kind: 'agent', token_hash: 'h' });
  const rows = HostsRepo.list();
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(LOCAL_HOST_ID));
  assert.ok(ids.includes('a'));
  assert.ok(ids.includes('b'));
  HostsRepo.delete('a');
  HostsRepo.delete('b');
});

test('HostsRepo: markSeen flips pending → online and updates last_seen', () => {
  HostsRepo.insert({ id: 'mark-test', label: 'm', kind: 'agent', token_hash: 'h', status: 'pending' });
  assert.equal(HostsRepo.findById('mark-test')!.status, 'pending');
  assert.equal(HostsRepo.findById('mark-test')!.last_seen, null);

  HostsRepo.markSeen('mark-test');
  const after = HostsRepo.findById('mark-test')!;
  assert.equal(after.status, 'online');
  assert.ok(after.last_seen !== null && after.last_seen > 0);

  HostsRepo.delete('mark-test');
});

test('HostsRepo: setStatus does not mutate last_seen', () => {
  HostsRepo.insert({ id: 'status-test', label: 's', kind: 'agent', token_hash: 'h' });
  HostsRepo.markSeen('status-test');
  const seen = HostsRepo.findById('status-test')!.last_seen;
  HostsRepo.setStatus('status-test', 'offline');
  const after = HostsRepo.findById('status-test')!;
  assert.equal(after.status, 'offline');
  assert.equal(after.last_seen, seen);
  HostsRepo.delete('status-test');
});

test('HostsRepo: update preserves enrolled_at and id', () => {
  HostsRepo.insert({ id: 'upd-test', label: 'before', kind: 'agent', token_hash: 'h' });
  const before = HostsRepo.findById('upd-test')!;
  const updated = HostsRepo.update('upd-test', { label: 'after', agent_version: '0.3.0' });
  assert.ok(updated);
  assert.equal(updated!.id, 'upd-test');
  assert.equal(updated!.label, 'after');
  assert.equal(updated!.agent_version, '0.3.0');
  assert.equal(updated!.enrolled_at, before.enrolled_at);
  HostsRepo.delete('upd-test');
});

test('HostsRepo: delete returns false for missing id, true for existing', () => {
  assert.equal(HostsRepo.delete('does-not-exist'), false);
  HostsRepo.insert({ id: 'del-test', label: 'd', kind: 'agent', token_hash: 'h' });
  assert.equal(HostsRepo.delete('del-test'), true);
  assert.equal(HostsRepo.findById('del-test'), undefined);
});

test('HostsRepo: seedLocalIfMissing is idempotent', () => {
  const before = HostsRepo.list().length;
  HostsRepo.seedLocalIfMissing();
  HostsRepo.seedLocalIfMissing();
  const after = HostsRepo.list().length;
  assert.equal(after, before, 'seedLocalIfMissing should not duplicate the local row');
});
