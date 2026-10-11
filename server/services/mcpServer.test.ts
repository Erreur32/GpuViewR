import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { _setDatabaseForTests, closeDatabase } from '../database/connection.js';
import { ApiTokenRepo, hashApiToken } from '../database/models/ApiToken.js';
import { handleMcpMessage } from './mcpServer.js';

before(() => {
  _setDatabaseForTests(new Database(':memory:'));
});
after(() => {
  closeDatabase();
});

type Reply = { result?: Record<string, unknown>; error?: { code: number } } | null;
const call = (msg: unknown) => handleMcpMessage(msg) as Reply;

test('initialize negotiates a supported protocol version', () => {
  const r = call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(r?.result?.protocolVersion, '2024-11-05');
  const fallback = call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(fallback?.result?.protocolVersion, '2025-06-18');
});

test('notifications get no reply', () => {
  assert.equal(handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('tools/list only exposes read-only tools', () => {
  const r = call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = r?.result?.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
  assert.ok(tools.length > 0);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
  assert.ok(tools.every((t) => /^(get|list)_/.test(t.name)));
});

test('unknown method and unknown tool are JSON-RPC errors', () => {
  assert.equal(call({ jsonrpc: '2.0', id: 1, method: 'resources/list' })?.error?.code, -32601);
  assert.equal(call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_host' } })?.error?.code, -32602);
  assert.equal(call({ nope: true })?.error?.code, -32600);
});

test('tools/call list_hosts answers from the database', () => {
  const r = call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_hosts', arguments: {} } });
  const content = r?.result?.content as Array<{ text: string }>;
  assert.deepEqual(JSON.parse(content[0].text), { hosts: [] });
});

test('ApiTokenRepo: plaintext is never stored, verify matches and revoke works', () => {
  const { token, record } = ApiTokenRepo.create('ci');
  assert.ok(token.startsWith('gvk_'));
  assert.equal(JSON.stringify(ApiTokenRepo.list()).includes(token), false);
  assert.equal(JSON.stringify(ApiTokenRepo.list()).includes(hashApiToken(token)), false);
  assert.equal(ApiTokenRepo.verify(token)?.id, record.id);
  assert.equal(ApiTokenRepo.verify(token + 'x'), null);
  assert.equal(ApiTokenRepo.verify('gvk_wrong'), null);
  assert.equal(ApiTokenRepo.delete(record.id), true);
  assert.equal(ApiTokenRepo.verify(token), null);
});
