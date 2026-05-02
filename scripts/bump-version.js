#!/usr/bin/env node
/**
 * Bump version across package.json, README.md, Header.tsx, CHANGELOG.md.
 * Usage: node scripts/bump-version.js [patch|minor|major]
 */
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const versionType = process.argv[2] || 'patch';

function increment(version, type) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3) throw new Error(`Invalid version: ${version}`);
  let [major, minor, patch] = parts;
  switch (type) {
    case 'major': major++; minor = 0; patch = 0; break;
    case 'minor': minor++; patch = 0; break;
    case 'patch':
    default: patch++; break;
  }
  return `${major}.${minor}.${patch}`;
}

const pkgPath = join(rootDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const current = pkg.version;
const next = increment(current, versionType);
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// Header.tsx — VERSION constant
const headerPath = join(rootDir, 'src/components/layout/Header.tsx');
let header = readFileSync(headerPath, 'utf-8');
header = header.replace(/const VERSION = 'v\d+\.\d+\.\d+';/, `const VERSION = 'v${next}';`);
writeFileSync(headerPath, header);

// README — generic vX.Y.Z badges
const readmePath = join(rootDir, 'README.md');
let readme = readFileSync(readmePath, 'utf-8');
readme = readme.replace(/GpuViewR-v?\d+\.\d+\.\d+/g, `GpuViewR-v${next}`);
writeFileSync(readmePath, readme);

console.log(`✓ Version bumped: ${current} → ${next}`);
console.log(`  - package.json`);
console.log(`  - src/components/layout/Header.tsx`);
console.log(`  - README.md`);
console.log(`Don't forget to update CHANGELOG.md!`);
