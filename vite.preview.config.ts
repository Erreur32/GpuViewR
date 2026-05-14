import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const PREVIEW_PORT = parseInt(process.env.PREVIEW_PORT || '5273', 10);

// Rewrite `/` to `/index.preview.html` for both dev and `vite preview`,
// so the sandbox is reachable at the bare host:port URL without the
// user having to type the explicit filename.
const rewriteIndex: Plugin = {
  name: 'preview-multi-default-route',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url === '/index.html') {
        req.url = '/index.preview.html';
      }
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/' || req.url === '/index.html') {
        req.url = '/index.preview.html';
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), rewriteIndex],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: PREVIEW_PORT,
    strictPort: true,
    host: '0.0.0.0',
  },
  preview: {
    port: PREVIEW_PORT,
    strictPort: true,
  },
  build: {
    outDir: 'dist-preview',
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      input: path.resolve(__dirname, 'index.preview.html'),
    },
  },
});
