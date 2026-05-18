#!/usr/bin/env node
/**
 * Local sanity check before pushing: runs `docker build`, reports image
 * size, and asserts the install-distribution files are inside the image.
 *
 * The file-presence check exists because v0.6.7 shipped install.ps1.tpl
 * in the repo and wired up GET /install.ps1 but the Dockerfile didn't
 * COPY the template into the runtime stage. The endpoint 503s for every
 * Windows user — bug only surfaced when the first real user pasted the
 * one-liner. Codifying the contract here turns that class of mistake
 * into a build-time failure.
 *
 * Usage: node scripts/check-docker-build.js
 */
import { spawnSync } from 'child_process';

const TAG = 'gpuviewr:check';

// Files the runtime image MUST contain for the install endpoints to work.
// Each entry is the path inside /app (the WORKDIR set by the Dockerfile).
// agent.mjs is bundled at build time, the rest is copied from the repo —
// either way, any of these missing == an install endpoint 503 in prod.
const REQUIRED_FILES = [
  'agent/install.sh.tpl',     // GET /install.sh         (Linux bare-metal)
  'agent/install.ps1.tpl',    // GET /install.ps1        (Windows, v0.6.7+)
  'agent/dist/agent.mjs',     // GET /agent.mjs          (bundle)
  'install-agent.sh',         // GET /install-agent.sh   (Docker variant)
];

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

// ── Required-files check ──────────────────────────────────────────────
// One `docker run` with `test -f` per path. Faster than pulling a shell
// (no extra layer needed; the runtime image already has `test`), and
// the exit code aggregates failures so the user sees every missing
// file in one pass instead of one-at-a-time.
console.log('→ Verifying required install-distribution files...');
const check = spawnSync(
  'docker',
  [
    'run', '--rm', '--entrypoint', 'sh', TAG,
    '-c',
    REQUIRED_FILES.map(f => `test -f '${f}' && echo "  ✓ ${f}" || echo "  ✗ ${f} MISSING"`).join('; ') +
    `; ${REQUIRED_FILES.map(f => `test -f '${f}'`).join(' && ')}`,
  ],
  { encoding: 'utf-8' },
);

if (check.stdout) process.stdout.write(check.stdout);
if (check.stderr) process.stderr.write(check.stderr);

if (check.status !== 0) {
  console.error('✗ Required-files check failed: one or more files are missing from the image.');
  console.error('  Fix: add the matching COPY line to the runtime stage in ./Dockerfile.');
  process.exit(2);
}

console.log('✓ All required install-distribution files present.');
