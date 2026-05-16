// esbuild driver for the agent bundle. Inline so we can inject the
// package.json version via --define without shell-escaping it through
// JSON. Matches the Vite trick used by the frontend (__APP_VERSION__).

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

await build({
  entryPoints: [resolve(__dirname, '..', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: resolve(__dirname, '..', 'dist', 'agent.mjs'),
  external: ['bufferutil', 'utf-8-validate'],
  define: { __AGENT_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: "import { createRequire as _createRequire } from 'module'; const require = _createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
