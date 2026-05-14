import path from 'path';
import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const SERVER_PORT = process.env.PORT || process.env.SERVER_PORT || '3015';
const CLIENT_PORT = parseInt(process.env.VITE_PORT || '5181', 10);

// Read the version from package.json at config time so the frontend
// always shows the version managed by scripts/update-version.sh,
// without ever hardcoding it inside a component.
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
).version as string;

const DEMO = process.env.VITE_DEMO === '1';
const BASE_PATH = process.env.VITE_BASE_PATH || '/';

// In the demo build we inject a strict CSP via <meta> so the static
// site, even when served from GitHub Pages, only talks to its own
// origin. The mock fetch and mock WebSocket never hit the network at
// runtime, so connect-src 'self' is enough to keep everything working.
const demoCspPlugin = {
  name: 'gpuviewr-demo-csp',
  transformIndexHtml(html: string): string {
    if (!DEMO) return html;
    // Note: `frame-ancestors` is intentionally omitted — browsers ignore
    // it when delivered via <meta>. GitHub Pages also sends X-Frame-Options
    // by default, so clickjacking protection is still in place.
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https://img.shields.io",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self'",
      "media-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    const tags = `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="robots" content="noindex, nofollow" />\n`;
    return html.replace('</head>', `${tags}  </head>`);
  },
};

const pwaPlugin = VitePWA({
  registerType: 'autoUpdate',
  includeAssets: ['logo.png', 'GPUViewR.png', 'alert.mp3'],
  manifest: {
    name: 'GpuViewR',
    short_name: 'GpuViewR',
    description: 'Real-time NVIDIA GPU monitoring dashboard',
    theme_color: '#0b1220',
    background_color: '#020617',
    display: 'standalone',
    start_url: BASE_PATH,
    scope: BASE_PATH,
    icons: [
      { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
    navigateFallback: `${BASE_PATH}index.html`,
    // Live data must never be cached — these endpoints stream real metrics.
    navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
    runtimeCaching: [],
  },
});

export default defineConfig({
  plugins: [react(), demoCspPlugin, pwaPlugin],
  base: BASE_PATH,
  define: {
    __APP_VERSION__: JSON.stringify(DEMO ? `${PKG_VERSION}-demo` : PKG_VERSION),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: CLIENT_PORT,
    host: '0.0.0.0',
    hmr: {
      clientPort: parseInt(process.env.DASHBOARD_PORT || String(CLIENT_PORT), 10),
    },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: DEMO ? 'dist-demo' : 'dist',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
  },
});
