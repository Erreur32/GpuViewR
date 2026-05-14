import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5182,
    host: '0.0.0.0',
    open: '/index.preview.html',
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
