#!/usr/bin/env node
/**
 * Local sanity check before pushing: runs `docker build` and reports image size.
 * Usage: node scripts/check-docker-build.js
 */
import { spawnSync } from 'child_process';

const TAG = 'gpuviewr:check';

console.log('→ Building image...');
const build = spawnSync('docker', ['build', '-t', TAG, '.'], { stdio: 'inherit' });
if (build.status !== 0) {
  console.error('✗ docker build failed');
  process.exit(build.status ?? 1);
}

const inspect = spawnSync('docker', ['image', 'inspect', TAG, '--format', '{{.Size}}'], {
  encoding: 'utf-8',
});
const size = parseInt((inspect.stdout || '0').trim(), 10);
const mb = (size / 1024 / 1024).toFixed(1);
console.log(`✓ Build OK: image size: ${mb} MB (${TAG})`);

if (size > 250 * 1024 * 1024) {
  console.warn(`! Image is larger than 250 MB: consider trimming dependencies`);
}
