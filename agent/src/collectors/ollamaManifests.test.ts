import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOllamaResolver, parseMountinfo, translatePath } from './ollamaManifests.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;

function writeManifest(modelsDir: string, model: string, tag: string): void {
  const dir = join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', model);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, tag), JSON.stringify({
    layers: [{ mediaType: 'application/vnd.ollama.image.model', digest: DIGEST }],
  }));
}

test('ollama resolver: finds the manifests next to the blob inside /proc/<pid>/root', (t) => {
  const prevEnv = process.env.OLLAMA_MANIFESTS_DIR;
  const tmp = mkdtempSync(join(tmpdir(), 'gv-ollama-'));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.OLLAMA_MANIFESTS_DIR;
    else process.env.OLLAMA_MANIFESTS_DIR = prevEnv;
  });
  // Point the static discovery at an empty dir so only the blob-side
  // lookup can answer.
  const empty = join(tmp, 'empty');
  mkdirSync(empty);
  process.env.OLLAMA_MANIFESTS_DIR = empty;

  const hostProc = join(tmp, 'proc');
  writeManifest(join(hostProc, '4242', 'root', 'root', '.ollama', 'models'), 'qwen3-4b-instruct', '64k');

  const resolver = createOllamaResolver(hostProc);
  const blobPath = `/root/.ollama/models/blobs/sha256-${'b'.repeat(64)}`;
  assert.equal(resolver.resolve(DIGEST), null);
  assert.equal(resolver.resolve(DIGEST, { blobPath, pid: 4242 }), 'qwen3-4b-instruct:64k');
  assert.equal(resolver.resolve(DIGEST, { blobPath, pid: 9999 }), null);
});

test('ollama resolver: plain host path next to the blob', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gv-ollama-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const models = join(tmp, 'models');
  writeManifest(models, 'llama3.1', '8b');
  const resolver = createOllamaResolver();
  const blobPath = join(models, 'blobs', `sha256-${'b'.repeat(64)}`);
  assert.equal(resolver.resolve(DIGEST, { blobPath }), 'llama3.1:8b');
});

test('translatePath: Docker bind mount of ~/.ollama maps to the host dir', () => {
  // Real jarvis capture: ollama container + host mountinfo.
  const theirs = parseMountinfo([
    '863 647 0:51 / / rw,relatime - overlay overlay rw',
    '932 863 259:6 /home/docker/llm/ollama /root/.ollama rw,relatime - ext4 /dev/nvme0n1p6 rw',
  ].join('\n'));
  const ours = parseMountinfo('29 1 259:6 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p6 rw');
  assert.equal(
    translatePath('/root/.ollama/models/manifests', theirs, ours),
    '/home/docker/llm/ollama/models/manifests',
  );
});

test('translatePath: separate /home partition and escaped spaces', () => {
  const theirs = parseMountinfo('10 1 8:2 /me/my\\040models /data rw - ext4 /dev/sda2 rw');
  const ours = parseMountinfo('20 1 8:2 / /home rw - ext4 /dev/sda2 rw');
  assert.equal(translatePath('/data/manifests', theirs, ours), '/home/me/my models/manifests');
});

test('translatePath: device not mounted on our side', () => {
  const theirs = parseMountinfo('863 647 0:51 / / rw - overlay overlay rw');
  const ours = parseMountinfo('29 1 259:6 / / rw - ext4 /dev/nvme0n1p6 rw');
  assert.equal(translatePath('/root/.ollama/models/manifests', theirs, ours), null);
});

test('ollama resolver: a symlink loop next to a crafted blob path does not hang', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'gv-ollama-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const manifests = join(tmp, 'models', 'manifests');
  mkdirSync(manifests, { recursive: true });
  symlinkSync(manifests, join(manifests, 'loop'));
  const resolver = createOllamaResolver();
  const blobPath = join(tmp, 'models', 'blobs', `sha256-${'b'.repeat(64)}`);
  assert.equal(resolver.resolve(DIGEST, { blobPath }), null);
});
