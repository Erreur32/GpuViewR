import path from 'path';
import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER_PORT = process.env.PORT || process.env.SERVER_PORT || '3015';
const CLIENT_PORT = parseInt(process.env.VITE_PORT || '5181', 10);

// Read the version from package.json at config time so the frontend
// always shows the version managed by scripts/update-version.sh,
// without ever hardcoding it inside a component.
const PKG_VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
).version as string;

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(PKG_VERSION),
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
    outDir: 'dist',
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 1000,
  },
});
